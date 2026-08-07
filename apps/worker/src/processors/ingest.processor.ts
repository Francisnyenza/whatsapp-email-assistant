import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB, type ProcessChangeJob } from '@wea/shared';
import { isHistoryExpired } from '@wea/mail';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { MessageRepository, type SealedBody } from '../repositories/message.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';
import { startWorker } from './base.processor.js';

/**
 * Email arriving.
 *
 * Gmail's push tells us only that *something* changed, never what — so this
 * walks the history from our stored cursor, persists what is new, and hands each
 * message to the notify queue.
 *
 * Three things govern it:
 *
 *  1. **Only new messages notify.** Persistence reports whether it created the
 *     row, and a message that was already stored is skipped. Redelivery is
 *     constant here, and notifying twice is the most visible bug this system
 *     could have.
 *  2. **The cursor advances only after the work succeeds.** Advancing first
 *     would silently skip mail whenever a fetch failed mid-batch — mail the
 *     user never learns about, which is worse than processing something twice.
 *  3. **An expired cursor is normal, not an incident.** Gmail keeps history for
 *     about a week, so a paused account comes back to a 404/412 rather than to
 *     silence. That path resyncs instead of dead-lettering.
 */
@Injectable()
export class IngestProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<ProcessChangeJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: AccountService,
    private readonly messages: MessageRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<ProcessChangeJob>({
      queueName: QUEUE.INGEST,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<ProcessChangeJob>): Promise<void> {
    const { userId, accountId, cursor } = job.data;

    const account = await this.accounts.load(userId, accountId);
    const provider = this.accounts.providerFor('gmail');

    let processed = 0;
    let notified = 0;
    let latestCursor = cursor;

    try {
      for await (const change of provider.fetchChanges(account, cursor)) {
        // Deletions and label changes matter for keeping our copy honest, but
        // neither is something to notify about — the user made those.
        if (change.type !== 'messageAdded') continue;

        processed++;

        const message = await provider
          .getMessage(account, change.providerMessageId)
          .catch((err: unknown) => {
            const error = AppError.from(err);
            // A message deleted between the history record and our fetch is
            // ordinary, not a failure. Skip it and keep going rather than
            // failing the whole batch over one vanished message.
            if (error.code === 'NOT_FOUND') return null;
            throw error;
          });

        if (!message) continue;

        const sealed = await this.sealBody(userId, message.bodyText);
        const stored = await this.messages.persist(userId, accountId, message, sealed);

        if (!stored.isNew) continue;

        notified++;
        // Analysis first, and it is the analysis job that queues the
        // notification — so a card can carry a summary. That handler always
        // notifies, including when the model is absent, over budget or broken,
        // so putting it in the path cannot cost an email its delivery.
        await this.queue.enqueue(
          QUEUE.AI,
          JOB.ANALYZE_EMAIL,
          { emailMessageId: stored.emailMessageId, userId },
          // Keyed on our own row id, so a redelivered ingest job cannot produce
          // a second notification for the same email.
          { jobId: `analyze:${stored.emailMessageId}` },
        );

        latestCursor = change.providerMessageId;
      }

      // Only now. See the class comment.
      if (job.data.cursor) {
        await this.messages.setCursor(userId, accountId, latestCursor ?? job.data.cursor);
      }

      this.logger.info(
        { event: 'ingest.completed', accountId, processed, notified },
        'Mailbox changes processed',
      );
    } catch (err) {
      const error = AppError.from(err);

      // The cursor is too old to serve. Normal for an account that was paused;
      // recover by taking a fresh cursor and carrying on from now.
      if (isHistoryExpired(error)) {
        const fresh = await provider.getInitialCursor(account);
        await this.messages.setCursor(userId, accountId, fresh);

        this.logger.warn(
          { event: 'ingest.history_expired', accountId },
          'Sync cursor expired; resynchronised from the current position',
        );
        // Deliberately not rethrown: this is a handled condition, and mail
        // older than the history window is not recoverable by retrying.
        return;
      }

      await this.messages.recordSyncFailure(userId, accountId, error.code);

      if (error.code === 'PROVIDER_UNAUTHORIZED') {
        await this.accounts.markReauthRequired(userId, accountId, error.code);
      }

      throw error;
    }
  }

  /**
   * Encrypts a body for storage, or gives up and stores the message without it.
   *
   * Two judgements are made here, both deliberate.
   *
   * The body is **truncated** past a fixed budget. A multi-megabyte body is
   * almost always a newsletter carrying inline base64 images, and the parts of
   * a message anything downstream reads — a summary, an embedding, a search
   * snippet — are at the top. Storing the whole thing would multiply the
   * database's size for content nobody reads. The marker is left in the text so
   * the truncation is visible rather than inferred from a message that seems to
   * stop mid-sentence.
   *
   * A failure to encrypt **does not fail ingest**. The alternative is dropping
   * an email over an encryption error, and the user hearing nothing at all —
   * which is worse than a notification whose body has to be re-fetched later.
   */
  private async sealBody(userId: string, bodyText: string): Promise<SealedBody | undefined> {
    if (!bodyText) return undefined;

    const truncated =
      Buffer.byteLength(bodyText, 'utf8') > MAX_STORED_BODY_BYTES
        ? `${Buffer.from(bodyText, 'utf8')
            .subarray(0, MAX_STORED_BODY_BYTES)
            .toString('utf8')
            // The cut can land mid-character; the replacement char it produces
            // is dropped rather than stored.
            .replace(/�$/, '')}\n\n[Message truncated.]`
        : bodyText;

    try {
      return await this.accounts.encryptMessageBody(userId, truncated);
    } catch (err) {
      this.logger.error(
        { event: 'ingest.body_seal_failed', err },
        'Could not encrypt a message body; storing the message without it',
      );
      return undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}

/**
 * How much of a body is kept. 256 KB of text is far more than any message a
 * person actually wrote; beyond it is markup and inline images.
 */
export const MAX_STORED_BODY_BYTES = 256 * 1024;
