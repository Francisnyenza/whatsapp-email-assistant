import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { AppError, QUEUE, type SendEmailJob } from '@wea/shared';
import { buildReplyHeaders, resolveReplyRecipients } from '@wea/mail';
import { buildText } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { OutboundService } from '../services/outbound.service.js';
import { DraftRepository } from '../repositories/draft.repository.js';
import { startWorker } from './base.processor.js';

/**
 * Sending a reply.
 *
 * This is the moment the product's promise is kept or broken: the message
 * either lands inside the recipient's existing conversation, from the user's own
 * address, or it does not — and the recipient can tell.
 *
 * Three properties govern it:
 *
 *  1. **At most once.** The draft's `idempotencyKey` is unique and the status
 *     transition is guarded, so a retried job cannot send a second copy. A
 *     duplicate email is the failure a user notices most.
 *  2. **Threading headers are frozen at compose time**, not recomputed here. The
 *     thread may have moved on since, and a recomputed `References` would
 *     detach the reply from its own conversation (ADR 0003).
 *  3. **A failed send is reported.** Silently failing to send, having told the
 *     user "sending…", is worse than an error message.
 */
@Injectable()
export class SendProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<SendEmailJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: AccountService,
    private readonly drafts: DraftRepository,
    private readonly outbound: OutboundService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<SendEmailJob>({
      queueName: QUEUE.SEND,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<SendEmailJob>): Promise<void> {
    const { userId, draftId } = job.data;

    // Claim the draft. The transition from queued to sending is atomic, so a
    // duplicated job finds nothing to claim and stops here rather than sending
    // a second copy.
    const draft = await this.drafts.claimForSending(userId, draftId);

    if (!draft) {
      this.logger.info(
        { event: 'send.already_claimed', draftId },
        'Draft was already claimed by another attempt',
      );
      return;
    }

    const account = await this.accounts.load(userId, draft.accountId);
    const provider = this.accounts.providerFor('gmail');

    try {
      const result = await provider.send(account, {
        to: draft.to,
        ...(draft.cc.length ? { cc: draft.cc } : {}),
        subject: draft.subject,
        bodyText: draft.bodyText,
        // Frozen at compose time — see the class comment.
        ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
        ...(draft.references.length ? { references: draft.references } : {}),
        ...(draft.providerThreadId ? { providerThreadId: draft.providerThreadId } : {}),
        idempotencyKey: draft.idempotencyKey,
      });

      await this.drafts.markSent(userId, draftId, result.providerMessageId);

      await this.outbound.reply({
        userId,
        phoneNumber: draft.phoneNumber,
        payload: buildText(`Sent to ${draft.to[0]?.address ?? 'them'}.`),
        kind: 'reply_confirmation',
        ...(draft.inReplyToMessageId ? { emailMessageId: draft.inReplyToMessageId } : {}),
        lastInboundAt: draft.lastInboundAt,
      });

      this.logger.info(
        { event: 'send.completed', draftId, providerMessageId: result.providerMessageId },
        'Reply sent',
      );
    } catch (err) {
      const error = AppError.from(err);

      // Release the claim only when another attempt could plausibly succeed.
      // Returning a permanently-failed draft to `queued` would have it retried
      // forever; leaving a retryable one in `sending` would strand it.
      await this.drafts.markFailed(userId, draftId, error.publicMessage, error.retryable);

      if (error.code === 'PROVIDER_UNAUTHORIZED') {
        await this.accounts.markReauthRequired(userId, draft.accountId, error.code);
      }

      // Tell the user. We already said "sending…", so silence here reads as the
      // message having gone when it has not.
      if (!error.retryable) {
        await this.outbound
          .reply({
            userId,
            phoneNumber: draft.phoneNumber,
            payload: buildText(`I couldn't send that. ${error.publicMessage}`),
            kind: 'error',
            lastInboundAt: draft.lastInboundAt,
          })
          .catch(() => {
            // Reporting the failure must not mask the failure itself.
          });
      }

      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Never abandon an in-flight send: the provider call may already be in
    // progress, and killing it mid-request is how a message gets sent twice.
    await this.worker?.close();
  }
}

/** Builds the reply headers and recipients for a draft. Exported for testing. */
export function composeReplyFrom(
  original: {
    messageIdHeader: string;
    references: string[];
    subject: string;
    from: { name?: string; address: string };
    replyTo?: { name?: string; address: string };
    to: Array<{ name?: string; address: string }>;
    cc: Array<{ name?: string; address: string }>;
  },
  selfAddress: string,
  replyAll = false,
) {
  const headers = buildReplyHeaders(original);
  const recipients = resolveReplyRecipients(original, selfAddress, replyAll);

  return {
    to: recipients.to,
    cc: recipients.cc,
    subject: headers.subject,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  };
}
