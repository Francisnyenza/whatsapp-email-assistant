import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import {
  QUEUE,
  fromWhatsAppFormat,
  type HandleInboundJob,
  type InboundWhatsAppMessage,
  type CommandIntent,
} from '@wea/shared';
import { parseCommand, needsConfirmation } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { ThreadResolver } from '../services/thread-resolver.js';
import { InboxRepository } from '../repositories/inbox.repository.js';
import { startWorker } from './base.processor.js';

/**
 * Turns an inbound WhatsApp message into an action.
 *
 * The order encodes ADR 0004's separation between interpretation and
 * authorization:
 *
 *   1. Parse intent from *the user's own message*. Never from email content.
 *   2. Resolve which email it concerns, asking rather than guessing.
 *   3. If the verb is destructive, produce a confirmation carrying the resolved
 *      id — and stop. The action happens on the tap, not on this message.
 *
 * Nothing an email said can reach step 3, because step 1 never reads email.
 */
@Injectable()
export class CommandsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<HandleInboundJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: ThreadResolver,
    private readonly inbox: InboxRepository,
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

    // Step 1 — intent, from the user's channel only.
    const parsed = parseCommand(message.text ?? '');
    const namedTarget = namedTargetOf(parsed.intent);

    // Step 2 — which email.
    const [state, recent] = await Promise.all([
      this.inbox.findConversationState(user.id),
      this.inbox.findRecentCandidates(user.id),
    ]);

    const resolution = await this.resolver.resolve(message, {
      deliveryLookup: (whatsappMessageId) =>
        this.inbox.findEmailByDelivery(user.id, whatsappMessageId),
      activeEmailMessageId: state?.activeEmailMessageId ?? null,
      activeStateExpiresAt: state?.expiresAt ?? null,
      recent,
      ...(namedTarget ? { namedTarget } : {}),
    });

    // Step 3 — destructive verbs become a confirmation, never an action.
    const requiresTap = needsConfirmation(parsed.intent);

    await this.inbox.recordResolution(user.id, message.id, parsed.intent.intent, parsed.source);

    // Remember what we settled on, so a follow-up "yes" lands on the same email.
    if (resolution.outcome === 'resolved') {
      await this.inbox.touchConversation(user.id, message.timestamp, resolution.emailMessageId);
    }

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
      },
      'Inbound command processed',
    );
  }

  async onModuleDestroy(): Promise<void> {
    // Let in-flight jobs finish rather than abandoning them mid-send.
    await this.worker?.close();
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
