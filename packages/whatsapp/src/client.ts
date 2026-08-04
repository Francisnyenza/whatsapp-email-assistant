import {
  AppError,
  toWhatsAppFormat,
  type WhatsAppOutboundPayload,
  type WhatsAppSendResult,
} from '@wea/shared';
import { enforceLimits } from './builders.js';

/**
 * WhatsApp Business Cloud API client.
 *
 * Deliberately thin: build the request, send it, map the failure. Everything
 * that decides *what* to send lives in the session-window and builder modules,
 * because those decisions are testable without a network and this is not.
 */

export interface WhatsAppClientOptions {
  phoneNumberId: string;
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Meta error codes worth distinguishing. Everything else is a generic provider
 * error — the distinction that matters operationally is whether retrying helps
 * and whether the user must act.
 */
const META_ERRORS = {
  /** Access token expired or revoked — retrying will not help. */
  AUTH: [190, 102],
  /** Rate limited by Meta. Back off. */
  RATE_LIMIT: [4, 80007, 130429, 131048],
  /** Outside the 24-hour window; only a template will be delivered. */
  SESSION_EXPIRED: [131047, 131051],
  /** The recipient's number is not on WhatsApp, or has blocked the business. */
  UNDELIVERABLE: [131026, 131052, 131053],
  /** Transient upstream failure. */
  TRANSIENT: [1, 2, 131000, 131016],
} as const;

interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

export class WhatsAppClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WhatsAppClientOptions) {
    const version = options.apiVersion ?? 'v21.0';
    this.baseUrl = options.baseUrl ?? `https://graph.facebook.com/${version}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Sends a message.
   *
   * @param to E.164 with '+', as stored. Converted to Meta's format here so no
   *   caller has to remember which representation applies where.
   */
  async send(to: string, payload: WhatsAppOutboundPayload): Promise<WhatsAppSendResult> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWhatsAppFormat(to),
      ...serializePayload(enforceLimits(payload)),
    };

    const response = await this.request<{
      messages?: Array<{ id: string }>;
      contacts?: Array<{ wa_id: string }>;
    }>(`/${this.options.phoneNumberId}/messages`, { method: 'POST', body });

    const messageId = response.messages?.[0]?.id;
    if (!messageId) {
      throw new AppError('PROVIDER_ERROR', 'WhatsApp accepted the send but returned no message id');
    }
    return { messageId, recipient: response.contacts?.[0]?.wa_id ?? toWhatsAppFormat(to) };
  }

  /** Marks an inbound message read, so the user sees the blue ticks. */
  async markRead(whatsappMessageId: string): Promise<void> {
    await this.request(`/${this.options.phoneNumberId}/messages`, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', status: 'read', message_id: whatsappMessageId },
    });
  }

  /**
   * Resolves a media id to a short-lived download URL.
   *
   * The URL expires in minutes and requires the same bearer token, so it is
   * fetched at download time rather than stored.
   */
  async getMediaUrl(
    mediaId: string,
  ): Promise<{ url: string; mimeType: string; sizeBytes: number }> {
    const meta = await this.request<{ url: string; mime_type: string; file_size: number }>(
      `/${mediaId}`,
      { method: 'GET' },
    );
    return { url: meta.url, mimeType: meta.mime_type, sizeBytes: meta.file_size };
  }

  /** Downloads media bytes. Requires the bearer token even on the CDN URL. */
  async downloadMedia(url: string, maxBytes: number): Promise<Buffer> {
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      signal: AbortSignal.timeout(this.timeoutMs * 3),
    });

    if (!response.ok) {
      throw new AppError('PROVIDER_ERROR', `Media download failed with ${response.status}`);
    }

    // Trust the header only as a fast reject; the real limit is enforced on the
    // bytes actually read, since Content-Length can lie.
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      throw new AppError('BAD_REQUEST', 'Attachment exceeds the size limit', {
        publicMessage: 'That file is too large to send by email.',
      });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new AppError('BAD_REQUEST', 'Attachment exceeds the size limit', {
        publicMessage: 'That file is too large to send by email.',
      });
    }
    return buffer;
  }

  /** Uploads media and returns the id to reference in a send. */
  async uploadMedia(content: Buffer, mimeType: string, filename: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([content], { type: mimeType }), filename);

    const response = await this.fetchImpl(`${this.baseUrl}/${this.options.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs * 3),
    });

    if (!response.ok) {
      throw await this.toError(response);
    }
    const body = (await response.json()) as { id?: string };
    if (!body.id) throw new AppError('PROVIDER_ERROR', 'Media upload returned no id');
    return body.id;
  }

  private async request<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
    let lastError: AppError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          headers: {
            Authorization: `Bearer ${this.options.accessToken}`,
            'Content-Type': 'application/json',
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) return (await response.json()) as T;

        const error = await this.toError(response);
        if (!error.retryable || attempt === this.maxRetries) throw error;
        lastError = error;
      } catch (err) {
        const error = normalizeTransportError(err);
        if (!error.retryable || attempt === this.maxRetries) throw error;
        lastError = error;
      }

      // Exponential backoff with jitter, so a Meta hiccup does not become a
      // thundering herd when every worker retries in lockstep.
      const backoff = 500 * 2 ** attempt;
      await sleep(backoff + Math.random() * backoff * 0.3);
    }

    throw lastError ?? new AppError('PROVIDER_ERROR', 'WhatsApp request failed');
  }

  private async toError(response: Response): Promise<AppError> {
    let body: MetaErrorBody = {};
    try {
      body = (await response.json()) as MetaErrorBody;
    } catch {
      // Meta occasionally returns HTML on a 5xx.
    }

    const code = body.error?.code ?? 0;
    const message = body.error?.message ?? `WhatsApp API returned ${response.status}`;
    const context = {
      httpStatus: response.status,
      metaCode: code,
      metaSubcode: body.error?.error_subcode,
      fbtraceId: body.error?.fbtrace_id,
    };

    if (includes(META_ERRORS.AUTH, code)) {
      return new AppError('PROVIDER_UNAUTHORIZED', message, {
        context,
        retryable: false,
        publicMessage: 'Our WhatsApp connection needs attention. We are on it.',
      });
    }

    if (includes(META_ERRORS.SESSION_EXPIRED, code)) {
      return new AppError('WHATSAPP_SESSION_EXPIRED', message, {
        context,
        retryable: false,
        publicMessage: 'Send us a message on WhatsApp first so we can reply.',
      });
    }

    if (includes(META_ERRORS.RATE_LIMIT, code) || response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      return new AppError('PROVIDER_RATE_LIMITED', message, {
        context,
        retryable: true,
        ...(retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      });
    }

    if (includes(META_ERRORS.UNDELIVERABLE, code)) {
      return new AppError('PROVIDER_ERROR', message, {
        context,
        retryable: false,
        publicMessage: 'We could not reach that WhatsApp number.',
      });
    }

    // 4xx that is not one of the above is our bug — a malformed payload — and
    // retrying an identical malformed request just burns quota.
    const retryable = response.status >= 500 || includes(META_ERRORS.TRANSIENT, code);
    return new AppError('PROVIDER_ERROR', message, { context, retryable });
  }
}

function includes(codes: readonly number[], code: number): boolean {
  return codes.includes(code);
}

function normalizeTransportError(err: unknown): AppError {
  if (AppError.isAppError(err)) return err;
  const name = err instanceof Error ? err.name : '';
  // Timeouts and connection resets are worth retrying; a programming error is not.
  const retryable = name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError';
  return new AppError('PROVIDER_ERROR', err instanceof Error ? err.message : String(err), {
    cause: err,
    retryable,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Maps our payload union onto Meta's wire format. */
export function serializePayload(payload: WhatsAppOutboundPayload): Record<string, unknown> {
  switch (payload.kind) {
    case 'text':
      return {
        type: 'text',
        text: { body: payload.body, preview_url: payload.previewUrl ?? false },
      };

    case 'buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(payload.header ? { header: { type: 'text', text: payload.header } } : {}),
          body: { text: payload.body },
          ...(payload.footer ? { footer: { text: payload.footer } } : {}),
          action: {
            buttons: payload.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };

    case 'list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(payload.header ? { header: { type: 'text', text: payload.header } } : {}),
          body: { text: payload.body },
          ...(payload.footer ? { footer: { text: payload.footer } } : {}),
          action: {
            button: payload.buttonText,
            sections: payload.sections.map((section) => ({
              title: section.title,
              rows: section.rows.map((row) => ({
                id: row.id,
                title: row.title,
                ...(row.description ? { description: row.description } : {}),
              })),
            })),
          },
        },
      };

    case 'media': {
      const media = {
        ...(payload.mediaId ? { id: payload.mediaId } : {}),
        ...(payload.link ? { link: payload.link } : {}),
        ...(payload.caption ? { caption: payload.caption } : {}),
        ...(payload.filename ? { filename: payload.filename } : {}),
      };
      return { type: payload.mediaType, [payload.mediaType]: media };
    }

    case 'template':
      return {
        type: 'template',
        template: {
          name: payload.name,
          language: { code: payload.languageCode },
          ...(payload.components ? { components: payload.components } : {}),
        },
      };
  }
}
