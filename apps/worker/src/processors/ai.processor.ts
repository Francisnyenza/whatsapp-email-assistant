import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB, type AnalyzeEmailJob } from '@wea/shared';
import { analyzeEmail } from '@wea/ai';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { AiService } from '../services/ai.service.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';
import { startWorker } from './base.processor.js';

/**
 * Reading an email so the notification can say something useful.
 *
 * Sits between ingest and notify, and the single rule that governs it is that
 * **it must never be the reason an email fails to arrive**. A summary is an
 * improvement to a notification; the notification is the product. So every exit
 * from this handler — success, invalid model output, no API key, budget
 * exhausted, provider down — ends with the notification queued.
 *
 * That is also why the model call happens here rather than inside notify: a
 * slow or failing provider stalls this queue, not the one that delivers mail.
 *
 * Nothing the model returns reaches a mutating call. It produces a row that is
 * shown to the user, and the user decides (ADR 0004).
 */
@Injectable()
export class AiProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<AnalyzeEmailJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly ai: AiService,
    private readonly analyses: AnalysisRepository,
    private readonly messages: MessageRepository,
    private readonly accounts: AccountService,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<AnalyzeEmailJob>({
      queueName: QUEUE.AI,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<AnalyzeEmailJob>): Promise<void> {
    const { userId, emailMessageId } = job.data;

    try {
      await this.analyze(userId, emailMessageId);
    } catch (err) {
      const error = AppError.from(err);
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      // Retry a transient failure, but only while attempts remain. Retrying
      // forever would hold the email back forever, which is the one outcome
      // this handler is not allowed to produce.
      if (error.retryable && !lastAttempt) {
        this.logger.warn(
          { event: 'ai.analysis_retrying', emailMessageId, code: error.code },
          'Analysis failed; will retry',
        );
        // Notify is deliberately not queued here: a later attempt may still
        // produce a summary, and the job id makes a duplicate a no-op anyway.
        throw error;
      }

      this.logger.error(
        { event: 'ai.analysis_failed', emailMessageId, code: error.code, err: error },
        'Delivering without a summary',
      );
    }

    // Always. See the class comment.
    await this.notify(userId, emailMessageId);
  }

  private async analyze(userId: string, emailMessageId: string): Promise<void> {
    const provider = this.ai.provider();
    if (!provider) {
      // No key configured. An ordinary deployment state, not a failure — and
      // saying so once per email at info level beats an error nobody can act on.
      this.logger.info(
        { event: 'ai.disabled', emailMessageId },
        'No model provider configured; delivering without a summary',
      );
      return;
    }

    if (await this.ai.isOverBudget(userId)) {
      // A budget nobody enforces is a number in a config file. Mail still
      // arrives; it simply arrives plainer for the rest of the day.
      this.logger.warn(
        { event: 'ai.budget_exhausted', userId, emailMessageId },
        'Daily token budget spent; delivering without a summary',
      );
      return;
    }

    const message = await this.messages.findForAnalysis(userId, emailMessageId);
    if (!message) return;

    const bodyText = await this.body(userId, message);

    const result = await analyzeEmail(provider, {
      subject: message.subject,
      ...(message.fromName ? { fromName: message.fromName } : {}),
      fromAddress: message.fromAddress,
      bodyText,
      ...(message.locale ? { locale: message.locale } : {}),
    });

    await this.analyses.save(userId, emailMessageId, result.data, result.usage, result.cached);
    await this.analyses.recordUsage(userId, 'analysis', result.usage, { cached: result.cached });

    this.logger.info(
      {
        event: 'ai.analysed',
        emailMessageId,
        priority: result.data.priority,
        category: result.data.category,
        tokens: result.usage.totalTokens,
        // Worth its own field: this is the signal a security review looks for.
        flagged: result.data.containsInstructionLikeText,
      },
      'Email analysed',
    );
  }

  /**
   * The body, or the snippet.
   *
   * Bodies are purged on the retention schedule and sealing can fail at ingest,
   * so an analysable message may have only its 300-character preview. That is
   * thin but usable — and far better than skipping analysis for mail whose body
   * we no longer hold.
   */
  private async body(
    userId: string,
    message: {
      snippet: string;
      bodyTextCipher: Uint8Array | null;
      bodyDek: Uint8Array | null;
      bodyKeyVersion: number | null;
    },
  ): Promise<string> {
    if (!message.bodyTextCipher || !message.bodyDek || message.bodyKeyVersion === null) {
      return message.snippet;
    }

    try {
      return await this.accounts.decryptMessageBody(userId, {
        ciphertext: Buffer.from(message.bodyTextCipher),
        wrappedKey: Buffer.from(message.bodyDek),
        keyVersion: message.bodyKeyVersion,
      });
    } catch (err) {
      this.logger.warn(
        { event: 'ai.body_unavailable', err },
        'Could not decrypt the body; analysing the snippet instead',
      );
      return message.snippet;
    }
  }

  private async notify(userId: string, emailMessageId: string): Promise<void> {
    await this.queue.enqueue(
      QUEUE.NOTIFY,
      JOB.NOTIFY_EMAIL,
      { userId, emailMessageId },
      // The same id ingest would have used, so a path that notified directly
      // and this one cannot both produce a card for the same email.
      { jobId: `notify:${emailMessageId}` },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
