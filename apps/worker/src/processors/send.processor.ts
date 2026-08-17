import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Readable } from 'node:stream';
import {
  AppError,
  QUEUE,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  type SendEmailJob,
  type OutboundAttachment,
} from '@wea/shared';
import { buildReplyHeaders, resolveReplyRecipients, type ProviderAccount } from '@wea/mail';
import { buildText } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { OutboundService } from '../services/outbound.service.js';
import { DraftRepository } from '../repositories/draft.repository.js';
import { StagedAttachmentRepository } from '../repositories/staged-attachment.repository.js';
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
    private readonly staged: StagedAttachmentRepository,
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
    const draft = await this.drafts.claimForSending(userId, draftId, (sealed) =>
      this.accounts.decryptBody(userId, sealed),
    );

    if (!draft) {
      this.logger.info(
        { event: 'send.already_claimed', draftId },
        'Draft was already claimed by another attempt',
      );
      return;
    }

    const account = await this.accounts.load(userId, draft.accountId);
    const provider = this.accounts.providerFor(account.provider);

    try {
      // A forward carries the original's files. They are fetched here rather
      // than stored at compose time, so the forwarded copy ends up in two
      // mailboxes and in neither of our stores.
      const attachments = [
        ...(draft.kind === 'forward' && draft.inReplyToMessageId
          ? await this.collectForwardedAttachments(userId, account, draft.inReplyToMessageId)
          : []),
        // Files the user sent into the chat, fetched from Meta for the same
        // reason a forward's are fetched from the provider: the bytes pass
        // through on their way to the recipient and are stored nowhere.
        ...(await this.collectStagedAttachments(userId, draftId)),
      ];

      const result = await provider.send(account, {
        to: draft.to,
        ...(draft.cc.length ? { cc: draft.cc } : {}),
        subject: draft.subject,
        bodyText: draft.bodyText,
        ...(attachments.length ? { attachments } : {}),
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
        // The attachment count is named because the user cannot see the sent
        // message. "Sent to alice@acme.com." is indistinguishable from an email
        // that went without the file they attached to it.
        payload: buildText(
          `Sent to ${draft.to[0]?.address ?? 'them'}${describeAttachments(attachments.length)}.`,
        ),
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

  /**
   * Streams the original's attachments so a forward carries them.
   *
   * Total size was checked at compose time against a budget below the
   * provider's own limit, so this is not the place that decides whether they
   * fit. What it does decide is what happens when one cannot be fetched — and
   * the answer is to fail the send. Delivering a forward with the invoice
   * missing, having told the user it went, is the failure they cannot see and
   * cannot recover from.
   */
  private async collectForwardedAttachments(
    userId: string,
    account: ProviderAccount,
    emailMessageId: string,
  ): Promise<OutboundAttachment[]> {
    const provider = this.accounts.providerFor(account.provider);
    const original = await this.drafts.findForForward(userId, emailMessageId);
    if (!original) return [];

    const message = await provider.getMessage(account, original.providerMessageId);
    const wanted = message.attachments.filter((a) => a.disposition !== 'inline');

    const collected: OutboundAttachment[] = [];
    for (const attachment of wanted) {
      const stream = await provider.getAttachment(
        account,
        original.providerMessageId,
        attachment.providerAttachmentId,
      );

      collected.push({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: await readAll(stream),
      });
    }

    this.logger.info(
      { event: 'send.attachments_collected', emailMessageId, count: collected.length },
      'Forwarded attachments fetched',
    );

    return collected;
  }

  /**
   * Fetches the files the user sent into the chat.
   *
   * Sized at staging time against the same budget a forward is sized against,
   * so this is not where the decision is made about whether they fit. What is
   * decided here is what happens when one cannot be fetched — and the answer is
   * the same as for a forward: fail the send. Meta keeps inbound media for 30
   * days, so a miss means the file is genuinely gone, and delivering the email
   * without the photo the user watched themselves attach is the failure they
   * cannot see and cannot undo.
   *
   * The cap passed to the client is the *whole message* budget rather than a
   * per-file one, deliberately: staging enforced the total, and a lower number
   * here would refuse a single large file that was already accepted.
   */
  private async collectStagedAttachments(
    userId: string,
    draftId: string,
  ): Promise<OutboundAttachment[]> {
    const files = await this.staged.listForDraft(userId, draftId);
    if (files.length === 0) return [];

    const collected: OutboundAttachment[] = [];
    for (const file of files) {
      collected.push({
        filename: file.filename,
        mimeType: file.mimeType,
        content: await this.outbound.fetchMedia(
          file.whatsappMediaId,
          MAX_OUTBOUND_ATTACHMENT_BYTES,
        ),
      });
    }

    this.logger.info(
      // Counts and bytes, never filenames: they are facts about the user's own
      // documents, exactly as on the delivery side.
      { event: 'send.staged_attachments_collected', draftId, count: collected.length },
      'Staged attachments fetched',
    );

    return collected;
  }

  async onModuleDestroy(): Promise<void> {
    // Never abandon an in-flight send: the provider call may already be in
    // progress, and killing it mid-request is how a message gets sent twice.
    await this.worker?.close();
  }
}

/**
 * Buffers a stream.
 *
 * Attachments are streamed everywhere else precisely to avoid this, but a MIME
 * message has to be assembled whole before it can be base64-encoded and sent.
 * The compose-time size budget is what keeps this bounded.
 */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
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

/** " with 2 files" — or nothing at all, which is the common case. */
function describeAttachments(count: number): string {
  if (count === 0) return '';
  return count === 1 ? ' with the file' : ` with ${count} files`;
}
