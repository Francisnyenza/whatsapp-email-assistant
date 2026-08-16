import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  AppError,
  QUEUE,
  JOB,
  decodeActionPayload,
  fromWhatsAppFormat,
  type ActionPayload,
  type HandleInboundJob,
  type InboundWhatsAppMessage,
  type CommandIntent,
  type WhatsAppOutboundPayload,
  type DeliverAttachmentJob,
} from '@wea/shared';
import { parseRecipientList } from '@wea/mail';
import {
  parseCommand,
  needsConfirmation,
  buildText,
  buildDeleteConfirmation,
  buildDraftConfirmation,
} from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { ThreadResolver } from '../services/thread-resolver.js';
import { ResponsePlanner, type PlannedEffect } from '../services/response-planner.js';
import { OutboundService } from '../services/outbound.service.js';
import { MailboxActionService } from '../services/mailbox-action.service.js';
import { ReplyComposer } from '../services/reply-composer.js';
import { ForwardComposer } from '../services/forward-composer.js';
import { ComposeComposer } from '../services/compose-composer.js';
import { MailboxQueryService } from '../services/mailbox-query.service.js';
import { AssistantService } from '../services/assistant.service.js';
import { interpretTap, type TapEffect } from '../services/tap-interpreter.js';
import { InboxRepository } from '../repositories/inbox.repository.js';
import { AttachmentRepository } from '../repositories/attachment.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';
import { startWorker } from './base.processor.js';

/**
 * Turns an inbound WhatsApp message into an action.
 *
 * The order encodes ADR 0004's separation between interpretation and
 * authorization:
 *
 *   1. Parse intent from *the user's own message*. Never from email content.
 *   2. Resolve which email it concerns, asking rather than guessing.
 *   3. Carry out what was decided.
 *   4. Report what actually happened.
 *
 * Nothing an email said can reach step 3, because step 1 never reads email.
 *
 * Steps 3 and 4 are in that order deliberately, and it is the order that
 * matters most here. Telling someone "Archived" and then failing to archive is
 * worse than any error message: they stop thinking about it, and the mail is
 * still sitting in their inbox. So the action happens first, and the sentence
 * the user receives describes the outcome rather than the intention.
 *
 * A tap is handled ahead of all of this. It is not a message to interpret — the
 * id came from a button we minted, carrying our own record id, which is exactly
 * what makes a confirmation tap an authorization rather than a UI gesture.
 */
@Injectable()
export class CommandsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<HandleInboundJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: ThreadResolver,
    private readonly planner: ResponsePlanner,
    private readonly outbound: OutboundService,
    private readonly mailbox: MailboxActionService,
    private readonly replies: ReplyComposer,
    private readonly forwards: ForwardComposer,
    private readonly composer: ComposeComposer,
    private readonly queries: MailboxQueryService,
    private readonly assistant: AssistantService,
    private readonly inbox: InboxRepository,
    private readonly attachments: AttachmentRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<HandleInboundJob>({
      queueName: QUEUE.COMMANDS,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<HandleInboundJob>): Promise<void> {
    const message = job.data.payload as InboundWhatsAppMessage;
    const phoneNumber = fromWhatsAppFormat(job.data.phoneNumber);

    const user = await this.inbox.findUserByPhone(phoneNumber);

    // Record the message before doing anything with it. "I replied and nothing
    // happened" is only answerable if the inbound side was written down
    // independently of whether handling succeeded.
    await this.inbox.recordInbound({
      userId: user?.id ?? null,
      whatsappMessageId: message.id,
      phoneNumber,
      messageType: message.type,
      ...(message.text ? { body: message.text } : {}),
      ...(message.context?.id ? { contextMessageId: message.context.id } : {}),
      receivedAt: message.timestamp,
    });

    if (!user) {
      // An unknown number. Almost always someone who found the business number
      // — but it is also how a phone gets verified, because the only way to
      // prove possession without an approved template is to have the user send
      // us something from it.
      const verified = await this.verifyPhone(message, phoneNumber);
      if (!verified) {
        this.logger.info(
          { event: 'command.unknown_sender' },
          'Message from a number with no connected account',
        );
        return;
      }

      // Verified just now, so the rest of this message is not a command — it is
      // the code. Confirm and stop; the window is open and the next message will
      // be handled normally.
      await this.outbound.reply({
        userId: verified.id,
        phoneNumber,
        payload: buildText(
          "You're connected. I'll send your email here — reply to any message to answer it.",
        ),
        kind: 'command_response',
        lastInboundAt: message.timestamp,
      });
      return;
    }

    // The messaging window reopens on every inbound message, whether or not we
    // understood it.
    await this.inbox.touchConversation(user.id, message.timestamp);

    // And with it open, whatever was held back can finally be delivered. This
    // is the moment that makes deferral honest rather than a politer word for
    // dropping mail — the scheduled sweep is a backstop for users who never
    // message us, not the main path.
    await this.flushDeferred(user.id, message.timestamp);

    const tap = message.interactive?.id ? decodeActionPayload(message.interactive.id) : null;
    if (tap) {
      await this.handleTap(user.id, phoneNumber, message, tap);
      return;
    }

    await this.handleText(user.id, phoneNumber, message);
  }

  /**
   * Links a phone number to the account that asked for it.
   *
   * The direction is deliberate and is not the obvious one. We cannot send a
   * free-form message to a number that has never messaged us — Meta's 24-hour
   * window — so a code sent *outbound* would need an approved template. Having
   * the user send us a code we showed them in the dashboard proves possession
   * just as well, needs no template, and opens the window at the same moment,
   * which is the window the first notification needs anyway.
   *
   * Nothing here trusts the message beyond the code: the account was chosen when
   * the code was issued, to an authenticated session, and this only attaches the
   * number it arrived from.
   */
  private async verifyPhone(
    message: InboundWhatsAppMessage,
    phoneNumber: string,
  ): Promise<{ id: string } | null> {
    const code = normalizeVerificationCode(message.text);
    if (!code) return null;

    try {
      const user = await this.inbox.redeemPhoneCode(hashVerificationCode(code), phoneNumber);
      if (user) {
        this.logger.info({ event: 'command.phone_verified', userId: user.id }, 'Phone verified');
      }
      return user;
    } catch (err) {
      // A failure here must not take the message handler down. The user simply
      // sees nothing and can try again, which is the same as any other
      // unrecognised message from an unknown number.
      this.logger.warn({ event: 'command.phone_verify_failed', err }, 'Could not verify a phone');
      return null;
    }
  }

  /**
   * Asks for a digest of anything held back while the window was shut.
   *
   * Bucketed by the hour so a conversational burst — "archive", "yes",
   * "thanks" — produces at most one digest rather than one per message. The
   * handler itself returns early when nothing is waiting, so enqueueing
   * unconditionally costs a job and no message.
   *
   * Failure is swallowed on purpose: the user asked us to do something else,
   * and a digest that could not be queued must not take their actual request
   * down with it.
   */
  private async flushDeferred(userId: string, at: Date): Promise<void> {
    try {
      await this.queue.enqueue(
        QUEUE.NOTIFY,
        JOB.SEND_DIGEST,
        { userId },
        { jobId: `digest:${userId}:reopen:${Math.floor(at.getTime() / 3_600_000)}` },
      );
    } catch (err) {
      this.logger.warn(
        { event: 'command.digest_flush_failed', err },
        'Could not queue the backlog digest',
      );
    }
  }

  /* ------------------------------- taps ---------------------------------- */

  /**
   * A button press.
   *
   * There is no interpretation to do: the id is one we minted, so the verb and
   * the target are both certain. What is left is to carry it out and say so.
   */
  private async handleTap(
    userId: string,
    phoneNumber: string,
    message: InboundWhatsAppMessage,
    tap: ActionPayload,
  ): Promise<void> {
    const emailMessageId = tap.targetId;
    const effect = interpretTap(tap);

    // Confirm the target exists before anything references it. A button from an
    // old notification can name an email that has since been purged, and every
    // step below — the conversation state, the delivery record's foreign key —
    // would otherwise fail on an id that was never going to resolve, retry, and
    // leave the user with no answer at all.
    const subject = await this.inbox.findSubject(userId, emailMessageId);

    if (subject === null) {
      await this.inbox.recordResolution(userId, message.id, `tap:${tap.action}`, 'button', 'gone');
      await this.outbound.reply({
        userId,
        phoneNumber,
        payload: buildText(userFacingFailure(new AppError('NOT_FOUND', 'gone'))),
        kind: 'command_response',
        lastInboundAt: message.timestamp,
      });
      this.logger.info(
        { event: 'command.tap_target_gone', action: tap.action },
        'Button press named an email that no longer exists',
      );
      return;
    }

    // A tap names an email, so it becomes the conversation's subject — the next
    // typed message lands on the same one.
    await this.inbox.touchConversation(userId, message.timestamp, emailMessageId);

    const { payload, failed } = await this.carryOutTap(userId, emailMessageId, subject, effect);

    await this.inbox.recordResolution(
      userId,
      message.id,
      `tap:${tap.action}`,
      'button',
      failed ?? undefined,
    );

    if (effect.kind === 'acknowledge' && tap.action === 'cancel') {
      await this.inbox.clearActiveThread(userId);
    }

    await this.outbound.reply({
      userId,
      phoneNumber,
      payload,
      kind: effect.kind === 'confirm' ? 'reply_confirmation' : 'command_response',
      emailMessageId,
      lastInboundAt: message.timestamp,
    });

    this.logger.info(
      { event: 'command.tap_handled', action: tap.action, effect: effect.kind, failed },
      'Button press handled',
    );
  }

  private async carryOutTap(
    userId: string,
    emailMessageId: string,
    subject: string,
    effect: TapEffect,
  ): Promise<{ payload: WhatsAppOutboundPayload; failed?: string }> {
    switch (effect.kind) {
      case 'mutate':
        return this.attempt(
          () => this.mailbox.apply(userId, emailMessageId, effect.operation),
          () => buildText(effect.confirmation),
        );

      case 'reply':
        return this.attempt(
          () => this.replies.composeReply({ userId, emailMessageId, bodyText: effect.body }),
          () => buildText(`Sending: “${effect.body}”`),
        );

      case 'confirm':
        return { payload: buildDeleteConfirmation(emailMessageId, subject) };

      case 'confirm_send':
        return this.carryOutSend(userId, emailMessageId);

      case 'await_reply_text':
        return { payload: buildText('What would you like to say? Just type it here.') };

      case 'acknowledge':
        return { payload: buildText(effect.message) };

      case 'unavailable':
        return {
          payload: buildText(
            `I can't ${effect.capability} yet — that part isn't finished. ` +
              'Try *reply*, *archive* or *delete*.',
          ),
        };
    }
  }

  /**
   * Whatever the user was asked to confirm sending.
   *
   * One pending slot for both a forward and a drafted reply, and that is not
   * tidiness — it is the bug it prevents. Both confirmations are buttons
   * carrying `confirm_send`, so two slots would mean a tap on the draft's
   * confirmation reaching for the forward's, and the user watching their mail
   * go to the wrong place for reasons they could never reconstruct. One slot,
   * one discriminant, one branch.
   *
   * What is being confirmed — the recipient, the words — comes from that slot,
   * written server-side when the user asked, never from the button. Reading it
   * also clears it, so a second tap sends nothing rather than a second copy.
   */
  private async carryOutSend(
    userId: string,
    emailMessageId: string,
  ): Promise<{ payload: WhatsAppOutboundPayload; failed?: string }> {
    const pending = await this.inbox.takePendingAction(userId, PENDING_SEND);

    // Expired, already spent, or pointing at a different email. Never guess:
    // sending someone's mail to the wrong address cannot be undone, and neither
    // can sending words they did not read.
    //
    // A mismatch consumes the pending confirmation rather than leaving it,
    // which costs the user one repeat of the command. That is the right way
    // round: the alternative lets a stale or crafted tap probe for what is
    // pending without spending it.
    const target = typeof pending?.emailMessageId === 'string' ? pending.emailMessageId : null;
    if (!pending || target !== emailMessageId) {
      return {
        payload: buildText(
          "That confirmation has expired. Ask me again and I'll set it up once more.",
        ),
        failed: 'no pending send',
      };
    }

    if (pending.kind === 'forward') {
      const recipient = typeof pending.recipient === 'string' ? pending.recipient : null;
      if (!recipient) {
        return { payload: buildText(GENERIC_FAILURE), failed: 'pending forward has no recipient' };
      }

      return this.attempt(
        () =>
          this.forwards.composeForward({
            userId,
            emailMessageId,
            recipient,
            ...(typeof pending.note === 'string' ? { note: pending.note } : {}),
          }),
        (summary) =>
          buildText(
            summary.attachmentCount > 0
              ? `Forwarding to ${recipient}, with ${describeAttachments(summary.attachmentCount)}…`
              : `Forwarding to ${recipient}…`,
          ),
      );
    }

    if (pending.kind === 'reply') {
      const body = typeof pending.body === 'string' ? pending.body : null;
      if (!body) {
        // A blank email under the user's name is worse than an error.
        return { payload: buildText(GENERIC_FAILURE), failed: 'pending reply has no body' };
      }

      return this.attempt(
        () => this.replies.composeReply({ userId, emailMessageId, bodyText: body }),
        () => buildText('Sending…'),
      );
    }

    return { payload: buildText(GENERIC_FAILURE), failed: 'unknown pending kind' };
  }

  /* ------------------------------- typed --------------------------------- */

  private async handleText(
    userId: string,
    phoneNumber: string,
    message: InboundWhatsAppMessage,
  ): Promise<void> {
    // Step 1 — intent, from the user's channel only.
    const parsed = parseCommand(message.text ?? '');
    const namedTarget = namedTargetOf(parsed.intent);

    // A read over the whole mailbox — "search invoices", "what's unread" —
    // concerns no particular email, so the resolution ladder has nothing to
    // resolve and the planner has nothing to plan. Answering it here, before
    // either runs, is what keeps the planner pure.
    if (this.queries.handles(parsed.intent)) {
      await this.answerQuery(userId, phoneNumber, message, parsed);
      return;
    }

    // Step 2 — which email.
    const [state, recent] = await Promise.all([
      this.inbox.findConversationState(userId),
      this.inbox.findRecentCandidates(userId),
    ]);

    const resolution = await this.resolver.resolve(message, {
      deliveryLookup: (whatsappMessageId) =>
        this.inbox.findEmailByDelivery(userId, whatsappMessageId),
      activeEmailMessageId: state?.activeEmailMessageId ?? null,
      activeStateExpiresAt: state?.expiresAt ?? null,
      recent,
      ...(namedTarget ? { namedTarget } : {}),
    });

    // Step 3 — decide what to say. Destructive verbs become a confirmation
    // here, never an action: the planner has no branch that reports success for
    // one.
    const requiresTap = needsConfirmation(parsed.intent);

    const subject =
      resolution.outcome === 'resolved'
        ? await this.inbox.findSubject(userId, resolution.emailMessageId)
        : null;

    const planned = this.planner.plan({
      intent: parsed.intent,
      resolution,
      ...(subject ? { subject } : {}),
      looksLikeReplyBody: parsed.looksLikeReplyBody,
      rawText: message.text ?? '',
    });

    // Remember what we settled on, so a follow-up "yes" lands on the same email.
    if (resolution.outcome === 'resolved') {
      await this.inbox.touchConversation(userId, message.timestamp, resolution.emailMessageId);
    }

    // A forward's recipient is recorded here, server-side, at the moment the
    // user names it — never carried on the confirmation button. That is what
    // makes the tap safe: it can only re-authorize this forward, and cannot
    // redirect their mail to an address that arrived with the tap.
    if (parsed.intent.intent === 'forward' && resolution.outcome === 'resolved') {
      await this.inbox.setPendingAction(userId, PENDING_SEND, {
        kind: 'forward',
        emailMessageId: resolution.emailMessageId,
        recipient: parsed.intent.recipient,
      });
    }

    // Step 4 — carry it out, *then* answer. The planner's payload describes a
    // completed action ("Archived."), so sending it before the action succeeds
    // would make it a false statement.
    const { payload, failed } = planned.effect
      ? await this.carryOutPlan(userId, planned.emailMessageId, planned.effect, planned.payload)
      : { payload: planned.payload, failed: undefined as string | undefined };

    await this.inbox.recordResolution(
      userId,
      message.id,
      parsed.intent.intent,
      parsed.source,
      failed ?? undefined,
    );

    await this.outbound.reply({
      userId,
      phoneNumber,
      payload,
      kind: requiresTap ? 'reply_confirmation' : 'command_response',
      ...(planned.emailMessageId ? { emailMessageId: planned.emailMessageId } : {}),
      lastInboundAt: message.timestamp,
    });

    this.logger.info(
      {
        event: 'command.handled',
        intent: parsed.intent.intent,
        source: parsed.source,
        resolution: resolution.outcome,
        rank: resolution.outcome === 'resolved' ? resolution.rank : undefined,
        basis: resolution.basis,
        candidates: recent.length,
        awaitingConfirmation: requiresTap,
        followUp: planned.followUp,
        failed,
      },
      'Inbound command processed',
    );
  }

  /**
   * Search and the standing lists.
   *
   * Failure produces a sentence rather than a thrown job: a search that could
   * not run is a disappointment, and a retried job would answer a question the
   * user has already given up on. The resolution record still gets written, so
   * "I searched and nothing happened" remains answerable.
   */
  private async answerQuery(
    userId: string,
    phoneNumber: string,
    message: InboundWhatsAppMessage,
    parsed: { intent: CommandIntent; source: string },
  ): Promise<void> {
    const { payload, failed } = await this.attempt(
      () => this.queries.answer(userId, parsed.intent),
      (result) => result ?? buildText(GENERIC_FAILURE),
    );

    await this.inbox.recordResolution(
      userId,
      message.id,
      parsed.intent.intent,
      parsed.source,
      failed ?? undefined,
    );

    await this.outbound.reply({
      userId,
      phoneNumber,
      payload,
      kind: 'command_response',
      lastInboundAt: message.timestamp,
    });

    this.logger.info(
      { event: 'command.handled', intent: parsed.intent.intent, source: parsed.source, failed },
      'Mailbox query processed',
    );
  }

  private async carryOutPlan(
    userId: string,
    emailMessageId: string | undefined,
    effect: PlannedEffect,
    intended: WhatsAppOutboundPayload,
  ): Promise<{ payload: WhatsAppOutboundPayload; failed?: string }> {
    // Handled before the target check, because a compose is the one effect with
    // no email behind it. Everything below acts on a message that already
    // exists; this originates one, so there is nothing to resolve and nothing
    // to guard against.
    if (effect.kind === 'compose') {
      return this.attempt(
        () =>
          this.composer.compose({
            userId,
            to: parseRecipientList(effect.to),
            ...(effect.cc ? { cc: parseRecipientList(effect.cc) } : {}),
            subject: effect.subject,
            bodyText: effect.body,
          }),
        ({ recipients }) =>
          buildText(
            recipients === 1 ? `Sending to ${effect.to}…` : `Sending to ${recipients} recipients…`,
          ),
      );
    }

    if (!emailMessageId) {
      // The planner only produces an effect alongside a resolved email, so this
      // is a bug rather than a user-facing condition — but reporting it as a
      // failure beats acting on an undefined id.
      return { payload: buildText(GENERIC_FAILURE), failed: 'no target' };
    }

    switch (effect.kind) {
      case 'mutate':
        return this.attempt(
          () => this.mailbox.apply(userId, emailMessageId, effect.operation),
          () => intended,
        );

      case 'reply':
        return this.attempt(
          () =>
            this.replies.composeReply({
              userId,
              emailMessageId,
              bodyText: effect.body,
              ...(effect.replyAll ? { replyAll: true } : {}),
            }),
          () => intended,
        );

      // One job per file rather than one for all of them. Each is a separate
      // download and a separate upload, and a single job that failed on the
      // third of four would retry the two that already arrived.
      case 'attachments':
        return this.attempt(
          async () => {
            const files = await this.attachments.listDeliverable(userId, emailMessageId);

            for (const file of files) {
              await this.queue.enqueue(
                QUEUE.MEDIA,
                JOB.DELIVER_ATTACHMENT,
                { userId, emailMessageId, attachmentId: file.id } satisfies DeliverAttachmentJob,
                // Keyed on the attachment, so asking twice does not send twice.
                { jobId: `media:${file.id}` },
              );
            }

            return files.length;
          },
          (count) =>
            count === 0
              ? buildText('That email has no attachments.')
              : buildText(count === 1 ? 'Sending the file…' : `Sending ${count} files…`),
        );

      // The answer *is* the message, so `intended` — "Reading it…" — is
      // discarded rather than sent. Sending both would be two notifications for
      // one question, and sending only the placeholder would be the "Archived."
      // failure in a new costume.
      case 'summarize':
        return this.attempt(
          () => this.assistant.summarize(userId, emailMessageId),
          (summary) => buildText(summary),
        );

      case 'translate':
        return this.attempt(
          () => this.assistant.translate(userId, emailMessageId, effect.language),
          (translated) => buildText(translated),
        );

      // Two round trips before anything is sent — synthesise, then stage the
      // bytes with Meta — and both sit inside `attempt`, so a failure at either
      // becomes a sentence rather than a voice note that never arrives.
      //
      // Nothing here mentions truncation. WhatsApp renders no caption on an
      // audio message, so a note about it would be written and never shown; the
      // recording says so in its own last line, which is where a listener is.
      case 'speak':
        return this.attempt(
          async () => {
            const spoken = await this.assistant.readAloud(userId, emailMessageId);
            return this.outbound.uploadAudio(spoken.audio, spoken.mimeType);
          },
          (mediaId) => ({ kind: 'media', mediaType: 'audio', mediaId }),
        );

      // Composes and asks. The one effect whose output could leave the
      // building, and the only one that ends in a button rather than an answer.
      case 'draft':
        return this.attempt(
          async () => {
            const body = await this.assistant.draftReply(
              userId,
              emailMessageId,
              effect.instruction,
            );

            // Written down *before* the confirmation is offered, and never onto
            // the button. WhatsApp echoes an interactive id straight back to us,
            // so words carried there would be words the client could change —
            // and the user would have approved one email and sent another. Same
            // reasoning as the forward's recipient, same slot.
            await this.inbox.setPendingAction(userId, PENDING_SEND, {
              kind: 'reply',
              emailMessageId,
              body,
            });

            return body;
          },
          (body) => buildDraftConfirmation(emailMessageId, body),
        );
    }
  }

  /* ------------------------------- shared -------------------------------- */

  /**
   * Runs an action and picks the message to send based on what happened.
   *
   * The whole point of this method is that the failure path produces a
   * different sentence. Reusing the optimistic one would be lying, and a
   * silently swallowed error here is indistinguishable to the user from the
   * feature not existing.
   */
  private async attempt<T>(
    action: () => Promise<T>,
    onSuccess: (result: T) => WhatsAppOutboundPayload,
  ): Promise<{ payload: WhatsAppOutboundPayload; failed?: string }> {
    try {
      return { payload: onSuccess(await action()) };
    } catch (err) {
      const error = AppError.from(err);

      this.logger.warn(
        { event: 'command.action_failed', code: error.code, err: error },
        'Could not carry out the requested action',
      );

      return {
        payload: buildText(userFacingFailure(error)),
        failed: error.code,
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Let in-flight jobs finish rather than abandoning them mid-send.
    await this.worker?.close();
  }
}

const GENERIC_FAILURE = "Something went wrong and I couldn't do that. Please try again.";

/**
 * The verification code as the user actually sent it.
 *
 * People add spaces, use lower case, and type O for 0 — which is why the
 * alphabet the code is generated from excludes both O and 0, along with every
 * other pair that is ambiguous on a phone screen. Anything that is not exactly
 * eight characters from that alphabet is not a code, and is left to be handled
 * as an ordinary message.
 */
function normalizeVerificationCode(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = text.trim().toUpperCase().replace(/[\s-]/g, '');
  return /^[2-9A-HJ-NP-Z]{8}$/.test(cleaned) ? cleaned : null;
}

/**
 * SHA-256, matching how the code was stored.
 *
 * Not Argon2id: this is 39 random bits with a ten-minute life, so a fast hash
 * gives an offline attacker nothing — and it has to be looked up *by value*
 * from an inbound message, which a salted hash cannot do.
 */
function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * The one key a pending send confirmation is stored under — a forward or a
 * drafted reply. Both are authorized by the same `confirm_send` tap, so they
 * must share a slot or the wrong one gets sent.
 */
const PENDING_SEND = 'awaiting_send_confirmation';

function describeAttachments(count: number): string {
  return count === 1 ? 'its attachment' : `its ${count} attachments`;
}

/**
 * Why it failed, in the user's terms.
 *
 * Only conditions the user can act on get a specific message; everything else
 * gets the generic line, because an internal error code on someone's phone is
 * noise at best and a disclosure at worst.
 */
function userFacingFailure(error: AppError): string {
  switch (error.code) {
    case 'NOT_FOUND':
      return "I couldn't find that email any more — it may have been deleted or moved.";
    case 'CONFLICT':
      return 'That email is already in your trash.';
    case 'PROVIDER_UNAUTHORIZED':
      return 'I lost access to your mailbox. Please reconnect it and try again.';
    case 'PROVIDER_RATE_LIMITED':
      return 'Your mail provider is rate-limiting us. Try again in a minute.';
    case 'PAYLOAD_TOO_LARGE':
      return "That email's attachments are too large to forward.";
    case 'BAD_REQUEST':
      return "I didn't have enough to go on there.";
    default:
      return GENERIC_FAILURE;
  }
}

/**
 * The target named in a command, when the intent carries one — "reply to Sarah",
 * "archive the invoice from Tom".
 */
function namedTargetOf(intent: CommandIntent): string | undefined {
  switch (intent.intent) {
    case 'reply':
    case 'archive':
    case 'delete':
    case 'summarize':
      return intent.target;
    default:
      return undefined;
  }
}
