import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
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
} from '@wea/shared';
import { parseCommand, needsConfirmation, buildText, buildDeleteConfirmation } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { ThreadResolver } from '../services/thread-resolver.js';
import { ResponsePlanner, type PlannedEffect } from '../services/response-planner.js';
import { OutboundService } from '../services/outbound.service.js';
import { MailboxActionService } from '../services/mailbox-action.service.js';
import { ReplyComposer } from '../services/reply-composer.js';
import { ForwardComposer } from '../services/forward-composer.js';
import { MailboxQueryService } from '../services/mailbox-query.service.js';
import { interpretTap, type TapEffect } from '../services/tap-interpreter.js';
import { InboxRepository } from '../repositories/inbox.repository.js';
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
    private readonly queries: MailboxQueryService,
    private readonly inbox: InboxRepository,
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
      // An unknown number. Not an error — anyone can message a business number —
      // but there is nothing to act on and no mailbox to expose.
      this.logger.info(
        { event: 'command.unknown_sender' },
        'Message from a number with no connected account',
      );
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

      case 'confirm_forward':
        return this.carryOutForward(userId, emailMessageId);

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
   * The forward the user was asked to confirm.
   *
   * The recipient comes from the pending action, written server-side when they
   * typed the command — never from the button. Reading it also clears it, so a
   * second tap on the same confirmation forwards nothing rather than sending a
   * second copy.
   */
  private async carryOutForward(
    userId: string,
    emailMessageId: string,
  ): Promise<{ payload: WhatsAppOutboundPayload; failed?: string }> {
    const pending = await this.inbox.takePendingAction(userId, PENDING_FORWARD);

    const recipient = typeof pending?.recipient === 'string' ? pending.recipient : null;
    const target = typeof pending?.emailMessageId === 'string' ? pending.emailMessageId : null;

    if (!recipient || target !== emailMessageId) {
      // Expired, already spent, or pointing somewhere else. Never guess a
      // recipient — sending someone's mail to the wrong address cannot be
      // undone.
      //
      // A mismatch consumes the pending confirmation rather than leaving it,
      // which costs the user one repeat of the command. That is the right way
      // round: the alternative lets a stale or crafted tap probe for what is
      // pending without spending it.
      return {
        payload: buildText(
          "That confirmation has expired. Tell me again who to forward it to and I'll ask once more.",
        ),
        failed: 'no pending forward',
      };
    }

    return this.attempt(
      () =>
        this.forwards.composeForward({
          userId,
          emailMessageId,
          recipient,
          ...(typeof pending?.note === 'string' ? { note: pending.note } : {}),
        }),
      (summary) =>
        buildText(
          summary.attachmentCount > 0
            ? `Forwarding to ${recipient}, with ${describeAttachments(summary.attachmentCount)}…`
            : `Forwarding to ${recipient}…`,
        ),
    );
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
      await this.inbox.setPendingAction(userId, PENDING_FORWARD, {
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
    if (!emailMessageId) {
      // The planner only produces an effect alongside a resolved email, so this
      // is a bug rather than a user-facing condition — but reporting it as a
      // failure beats acting on an undefined id.
      return { payload: buildText(GENERIC_FAILURE), failed: 'no target' };
    }

    if (effect.kind === 'mutate') {
      return this.attempt(
        () => this.mailbox.apply(userId, emailMessageId, effect.operation),
        () => intended,
      );
    }

    return this.attempt(
      () => this.replies.composeReply({ userId, emailMessageId, bodyText: effect.body }),
      () => intended,
    );
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

/** The pending-action key a forward confirmation is stored under. */
const PENDING_FORWARD = 'awaiting_forward_confirmation';

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
