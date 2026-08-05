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
    kind: 'command_response' | 'reply_confirmation' | 'error';
    emailMessageId?: string;
    lastInboundAt: Date | null;
  }): Promise<void> {
    const window = evaluateWindow({ lastInboundAt: input.lastInboundAt });

    if (window.mode !== 'free_form') {
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
