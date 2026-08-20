import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, toWhatsAppFormat, type WhatsAppOutboundPayload } from '@wea/shared';
import { WhatsAppClient, evaluateWindow } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { InboxRepository } from '../repositories/inbox.repository.js';

/**
 * Sending back to WhatsApp.
 *
 * Everything that decides *what* to say lives in the planner. This decides
 * whether we are allowed to say it, sends it, and records what happened.
 *
 * The window check is not a formality. Outside Meta's 24-hour customer service
 * window a free-form send is accepted by the API and then silently dropped — so
 * without this check the failure mode is not an error, it is a user who never
 * hears back and has no idea why.
 */
@Injectable()
export class OutboundService {
  private readonly client: WhatsAppClient;

  constructor(
    private readonly config: ConfigService,
    private readonly inbox: InboxRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    this.client = new WhatsAppClient({
      phoneNumberId: config.env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: config.env.WHATSAPP_ACCESS_TOKEN,
      apiVersion: config.env.WHATSAPP_API_VERSION,
      // Absent in every real deployment; present when the outbound half is
      // being exercised against a stub, which is the only way to see it work
      // without a live WhatsApp Business account.
      ...(config.env.WHATSAPP_API_BASE_URL
        ? { baseUrl: config.env.WHATSAPP_API_BASE_URL }
        : {}),
    });
  }

  /**
   * Replies to a user in an open conversation.
   *
   * Every path through the command processor is a *response* to something the
   * user just sent, so the window is open by construction — the inbound message
   * reopened it moments ago. The check stays anyway, because "by construction"
   * is exactly the kind of assumption that stops being true after a refactor.
   */
  async reply(input: {
    userId: string;
    phoneNumber: string;
    payload: WhatsAppOutboundPayload;
    kind: 'command_response' | 'reply_confirmation' | 'error' | 'notification' | 'digest';
    emailMessageId?: string;
    lastInboundAt: Date | null;
    /**
     * Set only for an approved template, which is the one shape Meta delivers
     * outside the window. Every other payload must stay behind the check —
     * naming the exception explicitly is what keeps it from becoming a general
     * escape hatch.
     */
    allowOutsideWindow?: boolean;
  }): Promise<void> {
    const window = evaluateWindow({ lastInboundAt: input.lastInboundAt });

    if (input.allowOutsideWindow && input.payload.kind !== 'template') {
      // The flag exists for templates. Anything else sent under it would be
      // accepted by the API and silently dropped, which is worse than an error
      // because nothing anywhere records that the user was never told.
      throw new AppError(
        'BAD_REQUEST',
        'Only a template may be sent outside the messaging window',
        { retryable: false },
      );
    }

    if (!input.allowOutsideWindow && window.mode !== 'free_form') {
      // Nothing useful to do: a template cannot carry an arbitrary answer, and
      // inventing one would be worse than staying quiet. Log it loudly instead
      // — this should be unreachable, and if it fires something upstream is
      // wrong with how inbound timestamps are recorded.
      this.logger.error(
        {
          event: 'outbound.window_closed',
          kind: input.kind,
          lastInboundAt: input.lastInboundAt,
        },
        'Cannot answer: messaging window closed while handling an inbound message',
      );
      return;
    }

    try {
      const result = await this.client.send(input.phoneNumber, input.payload);

      await this.inbox.recordDelivery({
        userId: input.userId,
        whatsappMessageId: result.messageId,
        phoneNumber: input.phoneNumber,
        kind: input.kind,
        ...(input.emailMessageId ? { emailMessageId: input.emailMessageId } : {}),
      });

      this.logger.info(
        { event: 'outbound.sent', kind: input.kind, waMessageId: result.messageId },
        'Response sent',
      );
    } catch (err) {
      const error = AppError.from(err);

      // Record the failure against the user so the delivery history shows the
      // gap rather than simply missing a row.
      await this.inbox
        .recordDelivery({
          userId: input.userId,
          phoneNumber: input.phoneNumber,
          kind: input.kind,
          status: 'failed',
          errorMessage: error.publicMessage,
          ...(input.emailMessageId ? { emailMessageId: input.emailMessageId } : {}),
        })
        .catch(() => {
          // A failure to record a failure must not mask the original error.
        });

      throw error;
    }
  }

  /**
   * Uploads audio and returns the media id to send it by.
   *
   * A separate step from `deliver` because Meta makes it one: a media message
   * carries an id, and that id is minted by a prior upload against the same
   * phone number. It lives here rather than at the call site so the API
   * credentials stay in the one class that already holds them.
   *
   * Deliberately not gated on the 24-hour messaging window. That window governs
   * what may be *sent*, not what may be staged, so checking it here would refuse
   * work that is perfectly legitimate — and the send that follows is checked
   * like every other one.
   *
   * @throws {AppError} when the upload fails. Not swallowed: by this point the
   *   user has been told a voice note is coming, and silence afterwards is the
   *   one outcome worse than an error message.
   */
  async uploadAudio(audio: Buffer, mimeType: string): Promise<string> {
    // Meta infers nothing from the filename, but the multipart upload requires
    // one, and an extension that matches the declared type is what keeps the
    // two from disagreeing in a way it rejects with a generic error.
    const extension = mimeType === 'audio/ogg' ? 'ogg' : 'mp3';

    return this.uploadMedia(audio, mimeType, `voice-note.${extension}`);
  }

  /**
   * Stages any file with Meta and returns the id to send it by.
   *
   * The filename is carried through rather than invented, because for an
   * attachment it is the thing the recipient sees and the only clue to what the
   * file is. Meta does not infer a type from it — the declared MIME type is
   * what matters — but a name that disagrees with the type is rejected with a
   * message that says nothing useful.
   */
  async uploadMedia(content: Buffer, mimeType: string, filename: string): Promise<string> {
    const mediaId = await this.client.uploadMedia(content, mimeType, filename);

    this.logger.info(
      // The filename is a fact about the user's mail, so it is not logged.
      { event: 'outbound.media_uploaded', bytes: content.length, mimeType },
      'Media staged for delivery',
    );

    return mediaId;
  }

  /**
   * Asks Meta what a piece of inbound media is, without downloading it.
   *
   * The webhook names the file and its type but never its size, and the size is
   * the one fact needed *before* the user is told their email is going. One
   * metadata call is cheap; discovering at send time that the attachment does
   * not fit, having already said "sending…", is not.
   */
  async describeMedia(mediaId: string): Promise<{ mimeType: string; sizeBytes: number }> {
    const meta = await this.client.getMediaUrl(mediaId);
    return { mimeType: meta.mimeType, sizeBytes: meta.sizeBytes };
  }

  /**
   * Downloads inbound media.
   *
   * The URL is resolved here rather than stored, because Meta's expires within
   * minutes while the media id is good for 30 days — which is what lets a file
   * be staged now and attached to an email later without holding the bytes.
   *
   * `maxBytes` is enforced by the client against what it actually reads, not
   * against the declared length.
   */
  async fetchMedia(mediaId: string, maxBytes: number): Promise<Buffer> {
    const meta = await this.client.getMediaUrl(mediaId);
    return this.client.downloadMedia(meta.url, maxBytes);
  }

  /** Marks the user's message read, so they see the blue ticks while we work. */
  async acknowledgeRead(whatsappMessageId: string): Promise<void> {
    try {
      await this.client.markRead(whatsappMessageId);
    } catch (err) {
      // Cosmetic. Never fail a job over read receipts.
      this.logger.debug({ event: 'outbound.mark_read_failed', err }, 'Could not mark read');
    }
  }

  /** E.164 in, Meta's format out — kept here so no caller has to remember. */
  static toWire(phone: string): string {
    return toWhatsAppFormat(phone);
  }
}
