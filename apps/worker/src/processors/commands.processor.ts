import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUE, type HandleInboundJob, type InboundWhatsAppMessage } from '@wea/shared';
import { parseCommand, needsConfirmation } from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { ThreadResolver } from '../services/thread-resolver.js';
import { startWorker } from './base.processor.js';

/**
 * Turns an inbound WhatsApp message into an action.
 *
 * The order here encodes ADR 0004's separation between interpretation and
 * authorization:
 *
 *   1. Parse intent from *the user's own message*. Never from email content.
 *   2. Resolve which email it concerns, asking rather than guessing.
 *   3. If the verb is destructive, send a confirmation carrying the resolved
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

  private async handle(job: Job<HandleInboundJob>): Promise<void> {
    const message = job.data.payload as InboundWhatsAppMessage;

    // Step 1 — intent, from the user's channel only.
    const parsed = parseCommand(message.text ?? '');

    // Step 2 — which email. The lookups are injected so this stays testable;
    // wiring them to repositories is the next commit.
    const resolution = await this.resolver.resolve(message, {
      deliveryLookup: async () => null,
      recent: [],
      ...(parsed.intent.intent === 'reply' && parsed.intent.target
        ? { namedTarget: parsed.intent.target }
        : {}),
    });

    // Step 3 — destructive verbs never execute here.
    const requiresTap = needsConfirmation(parsed.intent);

    this.logger.info(
      {
        event: 'command.handled',
        intent: parsed.intent.intent,
        source: parsed.source,
        resolution: resolution.outcome,
        rank: resolution.outcome === 'resolved' ? resolution.rank : undefined,
        basis: resolution.basis,
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
