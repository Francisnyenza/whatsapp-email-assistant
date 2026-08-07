import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB, type EmailAddress, type SendEmailJob } from '@wea/shared';
import { buildReplyHeaders, resolveReplyRecipients } from '@wea/mail';
import { AccountService } from './account.service.js';
import { DraftRepository } from '../repositories/draft.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';

/**
 * Turning what someone typed into WhatsApp into a reply on an email thread.
 *
 * This is where the product's central promise is kept: the recipient must
 * receive an ordinary email, in the conversation they were already having, from
 * the address they expect — with nothing about it suggesting a phone, a bot, or
 * a third party in the middle. Everything that makes that true is decided here
 * and frozen into the draft.
 *
 * Composition is separate from sending on purpose. The draft is durable before
 * anything leaves, so a crash between "the user asked" and "the mail went" ends
 * with a draft that can be retried rather than a reply that vanished — and the
 * send path's at-most-once guard has a row to hang off.
 */
@Injectable()
export class ReplyComposer {
  constructor(
    private readonly accounts: AccountService,
    private readonly drafts: DraftRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Composes a reply to one email and queues it.
   *
   * @returns the draft id, for the confirmation the user gets.
   * @throws {AppError} when the original is gone or the body is empty. Both are
   *   worth telling the user about — silently not sending is the one outcome
   *   they cannot recover from.
   */
  async composeReply(input: {
    userId: string;
    emailMessageId: string;
    bodyText: string;
    /** Reply-all is opt-in: quietly copying five people is not recoverable. */
    replyAll?: boolean;
  }): Promise<{ draftId: string }> {
    const body = input.bodyText.trim();
    if (!body) {
      throw new AppError('BAD_REQUEST', 'A reply needs something to say', { retryable: false });
    }

    const original = await this.drafts.findOriginal(input.userId, input.emailMessageId);
    if (!original) {
      throw new AppError('NOT_FOUND', 'That email is no longer available', { retryable: false });
    }

    const account = await this.accounts.load(input.userId, original.accountId);

    const { to, cc } = resolveReplyRecipients(
      {
        from: named(original.fromAddress, original.fromName),
        ...(original.replyTo ? { replyTo: named(original.replyTo) } : {}),
        to: original.toAddresses.map((address) => named(address)),
        cc: original.ccAddresses.map((address) => named(address)),
      },
      account.emailAddress,
      input.replyAll ?? false,
    );

    // Computed once, here, and stored. Recomputing them at send time would let a
    // thread that moved on in between detach the reply from its own
    // conversation (ADR 0003).
    const headers = buildReplyHeaders({
      messageIdHeader: original.messageIdHeader,
      references: original.references,
      subject: original.subject,
    });

    const sealed = await this.accounts.encryptBody(input.userId, body);

    const draft = await this.drafts.createForSend({
      userId: input.userId,
      accountId: original.accountId,
      inReplyToMessageId: original.id,
      to,
      ...(cc.length ? { cc } : {}),
      subject: headers.subject,
      // The plaintext is passed for the send path's convenience and the
      // ciphertext for storage; only the ciphertext is persisted.
      bodyText: body,
      bodyCipher: new Uint8Array(sealed.ciphertext),
      bodyDek: new Uint8Array(sealed.wrappedKey),
      bodyKeyVersion: sealed.keyVersion,
      ...(headers.inReplyTo ? { inReplyTo: headers.inReplyTo } : {}),
      references: headers.references,
      ...(original.thread?.providerThreadId
        ? { providerThreadId: original.thread.providerThreadId }
        : {}),
    });

    await this.queue.enqueue(
      QUEUE.SEND,
      JOB.SEND_EMAIL,
      {
        userId: input.userId,
        accountId: original.accountId,
        draftId: draft.id,
        idempotencyKey: draft.idempotencyKey,
      } satisfies SendEmailJob,
      // Keyed on the draft: a retried enqueue cannot become a second email, and
      // the send path's status guard catches whatever slips past that.
      { jobId: `send:${draft.id}` },
    );

    this.logger.info(
      {
        event: 'reply.composed',
        draftId: draft.id,
        emailMessageId: input.emailMessageId,
        recipients: to.length + cc.length,
      },
      'Reply composed and queued',
    );

    return { draftId: draft.id };
  }
}

function named(address: string, name?: string | null): EmailAddress {
  return name ? { address, name } : { address };
}
