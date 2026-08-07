import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { QUEUE, type NotifyEmailJob, type EmailPriority } from '@wea/shared';
import {
  buildEmailNotification,
  buildNewEmailTemplate,
  evaluateWindow,
  decideDelivery,
} from '@wea/whatsapp';
import { ConfigService } from '../config/config.service.js';
import { MessageRepository } from '../repositories/message.repository.js';
import { OutboundService } from '../services/outbound.service.js';
import { startWorker } from './base.processor.js';

/**
 * Delivering an email to WhatsApp.
 *
 * The product's headline promise, and the place where a user's stated
 * preferences are honoured or ignored. The decision of *whether* to send lives
 * in `decideDelivery`, which is pure and separately tested; this handler's job
 * is to gather the inputs, act on the verdict, and record what happened.
 *
 * Deliberately tolerant of a missing AI analysis. Summarisation is not built
 * yet, and even once it is, a failed model call must never block delivery — an
 * email with no summary is far better than an email that never arrives.
 */
@Injectable()
export class NotifyProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<NotifyEmailJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly messages: MessageRepository,
    private readonly outbound: OutboundService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<NotifyEmailJob>({
      queueName: QUEUE.NOTIFY,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<NotifyEmailJob>): Promise<void> {
    const { userId, emailMessageId, force } = job.data;

    const message = await this.messages.findForNotification(userId, emailMessageId);
    if (!message) {
      // Deleted between ingest and here. Not an error, and not retryable.
      this.logger.info({ event: 'notify.message_gone', emailMessageId });
      return;
    }

    const { preferences, state, user } = await this.messages.findDeliveryContext(userId);

    if (!user?.phoneNumber) {
      // Nothing to deliver to. A user can connect a mailbox before verifying a
      // number, so this is an ordinary state rather than a failure.
      this.logger.info({ event: 'notify.no_phone', userId }, 'No verified phone number');
      return;
    }

    const priority = (message.analysis?.priority ?? 'normal') as EmailPriority;
    const window = evaluateWindow({ lastInboundAt: state?.lastInboundAt ?? null });

    const action = force
      ? ({ action: 'send_now' } as const)
      : decideDelivery(
          {
            priority,
            category: message.analysis?.category ?? 'other',
            fromAddress: message.fromAddress,
          },
          {
            mode: preferences?.notificationMode ?? 'instant',
            minimumPriority: (preferences?.minimumPriority ?? 'normal') as EmailPriority,
            quietHoursEnabled: preferences?.quietHoursEnabled ?? false,
            quietHoursStart: preferences?.quietHoursStart ?? '22:00',
            quietHoursEnd: preferences?.quietHoursEnd ?? '07:00',
            timezone: user.timezone,
            mutedCategories: preferences?.mutedCategories ?? [],
            mutedSenders: preferences?.mutedSenders ?? [],
          },
          window,
        );

    if (action.action === 'suppress' || action.action === 'defer') {
      // Both are the user's own settings being honoured, so neither is a
      // failure — but they are logged distinctly, because "my mail stopped
      // arriving" is answered by exactly this line.
      this.logger.info(
        { event: `notify.${action.action}`, emailMessageId, reason: action.reason, priority },
        `Notification ${action.action}`,
      );
      return;
    }

    if (action.action === 'send_template') {
      // Outside the messaging window a free-form message is accepted by the API
      // and then never delivered, so this is the only shape that reaches the
      // user at all. It is a nudge rather than the card: the text is fixed at
      // approval time, so all it can do is prompt a reply — which reopens the
      // window, after which the real notification can be sent.
      await this.outbound.reply({
        userId,
        phoneNumber: user.phoneNumber,
        payload: buildNewEmailTemplate({
          ...(message.fromName ? { fromName: message.fromName } : {}),
          fromAddress: message.fromAddress,
          subject: message.subject,
          locale: user.locale,
        }),
        kind: 'notification',
        emailMessageId: message.id,
        lastInboundAt: state?.lastInboundAt ?? null,
        // The window is closed by definition here — that is the whole reason a
        // template is being sent rather than a card.
        allowOutsideWindow: true,
      });

      this.logger.info(
        { event: 'notify.template_sent', emailMessageId, priority },
        'Sent an out-of-window template notification',
      );
      return;
    }

    const card = buildEmailNotification({
      emailMessageId: message.id,
      ...(message.fromName ? { fromName: message.fromName } : {}),
      fromAddress: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      priority,
      category: message.analysis?.category ?? 'other',
      ...(message.analysis?.summary ? { summary: message.analysis.summary } : {}),
      attachmentCount: message.attachments.length,
      attachmentNames: message.attachments.map((a) => a.filename),
      suggestedReplies: message.analysis?.suggestedReplies ?? [],
      ...(message.analysis?.containsInstructionLikeText ? { flaggedForInstructionText: true } : {}),
      timezone: user.timezone,
      locale: user.locale,
    });

    await this.outbound.reply({
      userId,
      phoneNumber: user.phoneNumber,
      payload: card,
      kind: 'notification',
      emailMessageId: message.id,
      lastInboundAt: state?.lastInboundAt ?? null,
    });

    this.logger.info(
      { event: 'notify.sent', emailMessageId, priority },
      'Email delivered to WhatsApp',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
