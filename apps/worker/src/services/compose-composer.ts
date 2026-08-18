import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB, type SendEmailJob, type EmailAddress } from '@wea/shared';
import { QueueProducer } from '../queue/queue.producer.js';
import { AccountService } from './account.service.js';
import { DraftRepository } from '../repositories/draft.repository.js';

/**
 * A brand-new email, to someone the user names.
 *
 * The other two composers answer a message that already exists, and almost
 * everything they do is derived from it: the recipient comes from the `From:`
 * they are replying to, the subject from the original's, the threading headers
 * from its `Message-ID`. Nothing here is derived. Every field is something the
 * user said, which changes what can go wrong.
 *
 * Two consequences shape this class.
 *
 * **No threading headers, at all.** A fresh message is not part of a
 * conversation, so no `In-Reply-To` and no `References` — and the draft carries
 * no `inReplyToMessageId`, which is what makes the send path treat it as an
 * origination rather than an answer. Attaching a stray header here would graft
 * the message onto an unrelated thread in the recipient's client, which looks
 * to them like the user replying to something they never sent.
 *
 * **The recipient is validated before it reaches this class**, by
 * `parseRecipientList` in `@wea/mail`. That is the field where a mistake cannot
 * be recalled, and this class deliberately does not re-parse or "fix" anything
 * it is handed — a second, laxer parse is how a rejected address gets accepted
 * on the way through.
 *
 * Like every other outbound path, nothing here is reached without a
 * confirmation tap carrying a server-minted id (ADR 0004). The user's own words
 * still leave the building under their own name.
 */
@Injectable()
export class ComposeComposer {
  constructor(
    private readonly accounts: AccountService,
    private readonly drafts: DraftRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  async compose(input: {
    userId: string;
    to: EmailAddress[];
    cc?: EmailAddress[];
    /**
     * Blind copies. Carried straight through to the draft, where they sit in
     * their own column — the send path is what keeps them off the message the
     * other recipients see, and nothing here is allowed to fold them into `cc`.
     */
    bcc?: EmailAddress[];
    /**
     * Which mailbox to send from. Absent means the primary — the deterministic
     * answer rather than "whichever came back first".
     */
    accountId?: string;
    subject: string;
    bodyText: string;
  }): Promise<{ draftId: string; recipients: number }> {
    const body = input.bodyText.trim();
    if (!body) {
      // A blank email under someone's name is worse than an error.
      throw new AppError('BAD_REQUEST', 'An email needs something to say', {
        retryable: false,
        publicMessage: 'What should the email say?',
      });
    }

    if (input.to.length === 0) {
      throw new AppError('BAD_REQUEST', 'An email needs a recipient', {
        retryable: false,
        publicMessage: 'Who should I send it to?',
      });
    }

    // Bounded, and trimmed rather than rejected — an over-long subject is a
    // slip, not an attack, and refusing the whole message over one would be
    // disproportionate. The body is bounded by the chat itself.
    const subject = input.subject.trim().slice(0, MAX_SUBJECT_CHARS) || '(no subject)';

    // No parent message, so no account to inherit — either the user named one
    // and it was resolved before the confirmation they approved, or the primary,
    // which is the deterministic answer rather than "whichever came back first".
    const account = input.accountId
      ? await this.accounts.load(input.userId, input.accountId)
      : await this.accounts.loadPrimary(input.userId);

    const sealed = await this.accounts.encryptBody(input.userId, body);

    const draft = await this.drafts.createForSend({
      userId: input.userId,
      accountId: account.id,
      // No `inReplyToMessageId`, no `inReplyTo`, no `references`, no
      // `providerThreadId`. Their absence is the feature.
      kind: 'new',
      to: input.to,
      ...(input.cc?.length ? { cc: input.cc } : {}),
      ...(input.bcc?.length ? { bcc: input.bcc } : {}),
      subject,
      bodyText: body,
      bodyCipher: new Uint8Array(sealed.ciphertext),
      bodyDek: new Uint8Array(sealed.wrappedKey),
      bodyKeyVersion: sealed.keyVersion,
    });

    await this.queue.enqueue(
      QUEUE.SEND,
      JOB.SEND_EMAIL,
      {
        userId: input.userId,
        accountId: account.id,
        draftId: draft.id,
        idempotencyKey: draft.idempotencyKey,
      } satisfies SendEmailJob,
      // Keyed on the draft, exactly as a reply is: a retried enqueue cannot
      // become a second email, and the send path's status guard catches
      // whatever slips past that.
      { jobId: `send:${draft.id}` },
    );

    this.logger.info(
      {
        event: 'compose.composed',
        draftId: draft.id,
        accountId: account.id,
        // Counts, never addresses. A recipient list in a log is a contact list
        // in a log.
        recipients: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
      },
      'New email composed and queued',
    );

    return {
      draftId: draft.id,
      recipients: input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
    };
  }
}

/**
 * Long enough for any real subject, short enough that a pasted paragraph does
 * not become one. RFC 5322 recommends folding past 78 octets and mail clients
 * truncate their own display well before this.
 */
const MAX_SUBJECT_CHARS = 200;
