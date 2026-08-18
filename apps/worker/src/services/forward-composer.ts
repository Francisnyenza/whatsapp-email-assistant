import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  AppError,
  QUEUE,
  JOB,
  SEND_DELAY_MS,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  type SendEmailJob,
} from '@wea/shared';
import { buildForwardBody, buildForwardSubject } from '@wea/mail';
import { AccountService } from './account.service.js';
import { DraftRepository } from '../repositories/draft.repository.js';
import { StagedAttachmentRepository } from '../repositories/staged-attachment.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';

/**
 * Forwarding an email.
 *
 * Not a reply with a different recipient, which is why it has a composer of its
 * own. Three things differ, and each of them is visible to whoever receives it:
 *
 *  1. **It starts a new conversation.** No `In-Reply-To`, no `References` — a
 *     forward threaded onto the original lands inside the sender's thread in
 *     the recipient's client, which is wrong, and quietly discloses that the
 *     conversation continued elsewhere.
 *  2. **It reproduces the original**, quoted in the block every mail client
 *     renders, so the recipient sees an ordinary forwarded email.
 *  3. **It carries the attachments.** A forward that silently drops them is
 *     worse than a refusal: the sender believes the invoice went, and it did
 *     not.
 *
 * The original is fetched from the mailbox rather than read from our database.
 * Ingest deliberately stores only a 300-character snippet, so there is no body
 * here to quote — and fetching it means the forward carries the real message
 * for mail of any age, while we never hold a second copy of it. The attachments
 * work the same way: sized here, streamed at send time, stored nowhere.
 */

/**
 * Providers cap a message at 25 MB. Composing right up to the line and failing
 * at send would be the worst place to discover it, so the budget is lower and
 * the check happens before the user is promised anything.
 *
 * The same number governs files the user sends into the chat, and it is shared
 * rather than repeated — a forward carrying 18 MB of originals plus a staged
 * photo has to be measured against one ceiling, not two.
 */
export const MAX_FORWARD_ATTACHMENT_BYTES = MAX_OUTBOUND_ATTACHMENT_BYTES;

/** Deliberately narrow. A malformed address is a bounce, and a bounce the user never sees. */
const ADDRESS_RE = /^[^\s@<>",;]+@[^\s@<>",;.]+(\.[^\s@<>",;.]+)+$/;

export interface ForwardSummary {
  draftId: string;
  recipient: string;
  attachmentCount: number;
  attachmentBytes: number;
}

@Injectable()
export class ForwardComposer {
  constructor(
    private readonly accounts: AccountService,
    private readonly drafts: DraftRepository,
    private readonly staged: StagedAttachmentRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  async composeForward(input: {
    userId: string;
    emailMessageId: string;
    /** As the user typed it. Validated here rather than trusted. */
    recipient: string;
    /** Anything the user said alongside the command; goes above the quote. */
    note?: string;
  }): Promise<ForwardSummary> {
    const recipient = input.recipient.trim().toLowerCase();
    if (!ADDRESS_RE.test(recipient)) {
      throw new AppError('BAD_REQUEST', 'That does not look like an email address', {
        retryable: false,
      });
    }

    // Our own row first, and only for authorization: it is what proves this
    // user may see that mailbox message at all. Everything quoted below comes
    // from the provider.
    const record = await this.drafts.findForForward(input.userId, input.emailMessageId);
    if (!record || record.deletedAt) {
      throw new AppError('NOT_FOUND', 'That email is no longer available', { retryable: false });
    }

    const account = await this.accounts.load(input.userId, record.accountId);
    const provider = this.accounts.providerFor(account.provider);
    const original = await provider.getMessage(account, record.providerMessageId);

    // Inline images belong to the HTML body we are not reproducing; counting
    // them towards the budget would refuse forwards that would have been fine.
    const attachments = original.attachments.filter((a) => a.disposition !== 'inline');
    const originalBytes = attachments.reduce((total, a) => total + a.sizeBytes, 0);

    // Any file the user sent into the chat rides along on this draft, because
    // `createForSend` claims the pending set. It therefore counts against the
    // same ceiling: a 18 MB forward and a 15 MB photo are each fine and together
    // are a message the provider rejects — after the user has been told it went.
    const pending = await this.staged.listPending(input.userId);
    const attachmentBytes =
      originalBytes + pending.reduce((total, file) => total + file.sizeBytes, 0);

    if (attachmentBytes > MAX_FORWARD_ATTACHMENT_BYTES) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        'Those attachments are too large to forward by email',
        { retryable: false },
      );
    }

    const body = buildForwardBody(
      {
        from: original.from,
        to: original.to,
        cc: original.cc,
        subject: original.subject,
        sentAt: original.sentAt,
        bodyText: original.bodyText,
      },
      input.note,
    );

    const sealed = await this.accounts.encryptBody(input.userId, body);

    const draft = await this.drafts.createForSend({
      userId: input.userId,
      accountId: record.accountId,
      inReplyToMessageId: record.id,
      kind: 'forward',
      to: [{ address: recipient }],
      subject: buildForwardSubject(original.subject),
      bodyText: body,
      bodyCipher: new Uint8Array(sealed.ciphertext),
      bodyDek: new Uint8Array(sealed.wrappedKey),
      bodyKeyVersion: sealed.keyVersion,
      // No threading headers and no provider thread: a forward is its own
      // conversation. See the class comment.
      references: [],
    });

    await this.queue.enqueue(
      QUEUE.SEND,
      JOB.SEND_EMAIL,
      {
        userId: input.userId,
        accountId: record.accountId,
        draftId: draft.id,
        idempotencyKey: draft.idempotencyKey,
      } satisfies SendEmailJob,
      {
        jobId: `send:${draft.id}`,
        // The window "undo send" lives in. The job sits in Redis until it
        // passes; the draft's status guard is what decides whether it goes.
        delay: SEND_DELAY_MS,
      },
    );

    this.logger.info(
      {
        event: 'forward.composed',
        draftId: draft.id,
        emailMessageId: input.emailMessageId,
        attachmentCount: attachments.length + draft.attachmentCount,
        attachmentBytes,
        // The recipient is deliberately absent: the logger redacts addresses,
        // and naming one here would defeat that.
      },
      'Forward composed and queued',
    );

    return {
      draftId: draft.id,
      recipient,
      attachmentCount: attachments.length + draft.attachmentCount,
      attachmentBytes,
    };
  }
}
