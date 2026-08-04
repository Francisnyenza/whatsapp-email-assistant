import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { InboundWhatsAppMessage, WhatsAppStatusUpdate } from '@wea/shared';

/**
 * Inbound webhook parsing.
 *
 * Everything here is untrusted input from a public endpoint. The payload is
 * validated against a schema before any field is read, and unknown message types
 * degrade to `unknown` rather than throwing — Meta adds new types without notice,
 * and a worker crash-looping on an unrecognized sticker is a worse outcome than
 * an unhandled one.
 *
 * Signature verification happens *before* this, in the HTTP layer, against the
 * raw body (see @wea/crypto verifyMetaSignature).
 */

const contextSchema = z.object({ id: z.string(), from: z.string().optional() });

const mediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  filename: z.string().optional(),
  caption: z.string().optional(),
  voice: z.boolean().optional(),
});

const messageSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string(),
    context: contextSchema.optional(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    document: mediaSchema.optional(),
    audio: mediaSchema.optional(),
    video: mediaSchema.optional(),
    sticker: mediaSchema.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z
          .object({ id: z.string(), title: z.string(), description: z.string().optional() })
          .optional(),
      })
      .optional(),
    button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string(),
    recipient_id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    errors: z
      .array(
        z.object({
          code: z.number(),
          title: z.string().optional(),
          message: z.string().optional(),
          error_data: z.object({ details: z.string().optional() }).optional(),
        }),
      )
      .optional(),
    conversation: z
      .object({ id: z.string(), origin: z.object({ type: z.string() }).optional() })
      .optional(),
  })
  .passthrough();

export const whatsappWebhookSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z
            .object({
              messaging_product: z.string().optional(),
              metadata: z
                .object({ display_phone_number: z.string(), phone_number_id: z.string() })
                .optional(),
              contacts: z
                .array(
                  z.object({
                    wa_id: z.string(),
                    profile: z.object({ name: z.string() }).optional(),
                  }),
                )
                .optional(),
              messages: z.array(messageSchema).optional(),
              statuses: z.array(statusSchema).optional(),
            })
            .passthrough(),
        }),
      ),
    }),
  ),
});

export type WhatsAppWebhookPayload = z.infer<typeof whatsappWebhookSchema>;

export interface ParsedWebhook {
  messages: InboundWhatsAppMessage[];
  statuses: WhatsAppStatusUpdate[];
  /** wa_id → display name, when Meta included a contact profile. */
  contactNames: Map<string, string>;
  /** Which of our numbers received this, for multi-number deployments. */
  phoneNumberId?: string;
}

/**
 * Parses a verified webhook body.
 *
 * @returns null when the payload is not a WhatsApp business-account event, or
 *   fails validation. A malformed webhook is dropped with a log line, not an
 *   exception — Meta retries on non-2xx, and retrying a payload we can never
 *   parse is a loop.
 */
export function parseWebhook(body: unknown): ParsedWebhook | null {
  const result = whatsappWebhookSchema.safeParse(body);
  if (!result.success || result.data.object !== 'whatsapp_business_account') return null;

  const messages: InboundWhatsAppMessage[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];
  const contactNames = new Map<string, string>();
  let phoneNumberId: string | undefined;

  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      phoneNumberId ??= value.metadata?.phone_number_id;

      for (const contact of value.contacts ?? []) {
        if (contact.profile?.name) contactNames.set(contact.wa_id, contact.profile.name);
      }
      for (const raw of value.messages ?? []) {
        messages.push(toInboundMessage(raw));
      }
      for (const raw of value.statuses ?? []) {
        statuses.push(toStatusUpdate(raw));
      }
    }
  }

  return { messages, statuses, contactNames, phoneNumberId };
}

type RawMessage = z.infer<typeof messageSchema>;

function toInboundMessage(raw: RawMessage): InboundWhatsAppMessage {
  const base = {
    id: raw.id,
    from: raw.from,
    timestamp: parseTimestamp(raw.timestamp),
    ...(raw.context ? { context: raw.context } : {}),
  };

  switch (raw.type) {
    case 'text':
      return { ...base, type: 'text', text: raw.text?.body ?? '' };

    case 'interactive': {
      const reply = raw.interactive?.button_reply ?? raw.interactive?.list_reply;
      if (!reply) return { ...base, type: 'unknown' };
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: raw.interactive?.button_reply ? 'button_reply' : 'list_reply',
          id: reply.id,
          title: reply.title,
        },
      };
    }

    case 'button':
      // Quick-reply buttons on template messages report differently from
      // interactive buttons; the payload lands in a different field.
      return {
        ...base,
        type: 'button',
        text: raw.button?.text ?? '',
        ...(raw.button?.payload
          ? {
              interactive: {
                type: 'button_reply' as const,
                id: raw.button.payload,
                title: raw.button.text ?? '',
              },
            }
          : {}),
      };

    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'sticker': {
      const media = raw[raw.type];
      if (!media) return { ...base, type: 'unknown' };
      return {
        ...base,
        type: raw.type,
        ...(media.caption ? { text: media.caption } : {}),
        media: {
          id: media.id,
          mimeType: media.mime_type ?? 'application/octet-stream',
          sha256: media.sha256 ?? '',
          ...(media.filename ? { filename: media.filename } : {}),
          ...(media.caption ? { caption: media.caption } : {}),
          // Voice notes are audio with voice: true — the distinction matters,
          // because a voice note becomes an email and a music file does not.
          ...(media.voice !== undefined ? { voice: media.voice } : {}),
        },
      };
    }

    case 'location':
      return raw.location
        ? { ...base, type: 'location', location: raw.location }
        : { ...base, type: 'unknown' };

    default:
      // Reactions, orders, system messages, and whatever Meta ships next.
      return { ...base, type: 'unknown' };
  }
}

type RawStatus = z.infer<typeof statusSchema>;

function toStatusUpdate(raw: RawStatus): WhatsAppStatusUpdate {
  const error = raw.errors?.[0];
  return {
    messageId: raw.id,
    recipient: raw.recipient_id,
    status: normalizeStatus(raw.status),
    timestamp: parseTimestamp(raw.timestamp),
    ...(error
      ? {
          error: {
            code: error.code,
            title: error.title ?? error.message ?? 'Unknown error',
            ...(error.error_data?.details ? { details: error.error_data.details } : {}),
          },
        }
      : {}),
    ...(raw.conversation
      ? {
          conversation: {
            id: raw.conversation.id,
            ...(raw.conversation.origin?.type ? { category: raw.conversation.origin.type } : {}),
          },
        }
      : {}),
  };
}

function normalizeStatus(status: string): WhatsAppStatusUpdate['status'] {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
      return status;
    case 'accepted':
      return 'accepted';
    default:
      // 'deleted', 'warning' and future values: treat as sent rather than
      // failing, since the message did leave.
      return 'sent';
  }
}

/** Meta sends Unix seconds as a string. */
function parseTimestamp(value: string): Date {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

/**
 * A stable de-duplication key for a webhook delivery.
 *
 * Meta retries on any non-2xx and occasionally duplicates on success. Every
 * message carries a `wamid`, which is the natural key; this covers the envelope
 * as a whole for the `processed_webhooks` ledger.
 */
export function webhookDedupeKey(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/**
 * Meta's subscription handshake: it GETs the endpoint with a challenge and
 * expects the challenge echoed only if the verify token matches.
 *
 * @returns the challenge to echo, or null to respond 403.
 */
export function handleVerificationChallenge(
  query: Record<string, string | undefined>,
  expectedToken: string,
): string | null {
  if (query['hub.mode'] !== 'subscribe') return null;
  if (!expectedToken || query['hub.verify_token'] !== expectedToken) return null;
  return query['hub.challenge'] ?? null;
}
