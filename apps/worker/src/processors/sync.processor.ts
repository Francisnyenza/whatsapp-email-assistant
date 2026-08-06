import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB, type SweepWatchesJob, type RenewWatchJob } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { WatchRepository } from '../repositories/watch.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';
import {
  RENEWAL_HORIZON_HOURS,
  SWEEP_BATCH_SIZE,
  renewalJobId,
} from '../services/watch-schedule.js';
import { startWorker } from './base.processor.js';

type SyncJob = SweepWatchesJob | RenewWatchJob;

/**
 * Keeping mailboxes subscribed.
 *
 * Gmail's `users.watch` expires after seven days, and its expiry is announced
 * nowhere: pushes just stop. A mailbox connected on Monday goes quiet the
 * following Monday, with no error in any log and nothing for the user to see
 * except that their mail stopped arriving. That is the failure this handles,
 * and it is the single most likely way this system stops working in production.
 *
 * Two jobs, deliberately separate:
 *
 *  - **The sweep** finds what is due and fans out. It runs on a timer, so it
 *    has no tenant, and it reads only the routing table — never a mailbox.
 *  - **The renewal** acts on one account, fully tenant-scoped, and is the only
 *    half that can decrypt anything.
 *
 * Splitting them is what keeps a scheduled job from needing cross-tenant read
 * access to the table holding OAuth tokens. It also means one mailbox failing
 * to renew cannot stall the rest: each is its own job, its own retries, its own
 * dead letter.
 */
@Injectable()
export class SyncProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<SyncJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: AccountService,
    private readonly watches: WatchRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.worker = startWorker<SyncJob>({
      queueName: QUEUE.SYNC,
      redisUrl: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL,
      logger: this.logger,
      handler: (job) => this.handle(job),
    });
  }

  async handle(job: Job<SyncJob>): Promise<void> {
    switch (job.name) {
      case JOB.SWEEP_WATCHES:
        return this.sweep(job.data as SweepWatchesJob);
      case JOB.RENEW_WATCH:
        return this.renew(job.data as RenewWatchJob);
      default:
        // Not retryable: an unknown job name will still be unknown on the
        // fourth attempt. Straight to the dead letter, where it is visible.
        throw new AppError('BAD_REQUEST', `Unknown sync job: ${job.name}`, { retryable: false });
    }
  }

  /**
   * Finds mailboxes whose watch is lapsing and enqueues one renewal each.
   *
   * Capped per run. A backlog — after an outage, say — is drained over
   * successive sweeps rather than in one burst that would rate-limit us out of
   * the Gmail API and take ingest down with it.
   */
  private async sweep(data: SweepWatchesJob): Promise<void> {
    const sweepAt = new Date();
    const horizon = data.horizonHours ?? RENEWAL_HORIZON_HOURS;

    const due = await this.watches.findDue(horizon, SWEEP_BATCH_SIZE);

    for (const watch of due) {
      await this.queue.enqueue(
        QUEUE.SYNC,
        JOB.RENEW_WATCH,
        {
          userId: watch.userId,
          accountId: watch.accountId,
          dueAt: watch.expiresAt?.toISOString() ?? null,
        } satisfies RenewWatchJob,
        { jobId: renewalJobId(watch.accountId, watch.expiresAt, sweepAt) },
      );
    }

    this.logger.info(
      {
        event: 'sync.sweep_completed',
        due: due.length,
        horizonHours: horizon,
        // A full batch means there is more behind it. Worth knowing before the
        // backlog outlasts the seven-day window.
        saturated: due.length === SWEEP_BATCH_SIZE,
      },
      'Watch renewal sweep completed',
    );
  }

  /** Re-issues one mailbox's watch. Gmail's watch is idempotent, so this is safe to repeat. */
  private async renew(data: RenewWatchJob): Promise<void> {
    const { userId, accountId } = data;

    let account;
    try {
      account = await this.accounts.load(userId, accountId);
    } catch (err) {
      const error = AppError.from(err);

      if (error.code === 'NOT_FOUND' || error.code === 'PROVIDER_UNAUTHORIZED') {
        // The mailbox is gone or the grant was revoked. Drop the route so the
        // sweep stops finding it and pushes stop being routed to an account we
        // cannot read. Reconnecting re-creates it.
        await this.watches.dropRoute(accountId);
        this.logger.info(
          { event: 'sync.watch_route_dropped', accountId, code: error.code },
          'Removed the route for an unreachable mailbox',
        );
        return;
      }
      throw error;
    }

    const provider = this.accounts.providerFor('gmail');

    try {
      const handle = await provider.renewWatch(account);
      await this.watches.recordRenewed(userId, accountId, handle.expiresAt, handle.cursor.value);

      this.logger.info(
        { event: 'sync.watch_renewed', accountId, expiresAt: handle.expiresAt },
        'Gmail watch renewed',
      );
    } catch (err) {
      const error = AppError.from(err);

      if (error.code === 'PROVIDER_UNAUTHORIZED') {
        await this.accounts.markReauthRequired(userId, accountId, error.code);
        await this.watches.dropRoute(accountId);
        this.logger.warn(
          { event: 'sync.watch_reauth_required', accountId },
          'Mailbox needs reconnecting; watch cannot be renewed',
        );
        return;
      }

      if (error.code === 'DEPENDENCY_UNAVAILABLE') {
        // Pub/Sub is misconfigured. Retrying every hour for every account would
        // bury the dead letter queue in copies of one operator problem, so the
        // account is marked for the polling fallback and this is logged loudly
        // once per sweep instead.
        await this.watches.recordUnavailable(userId, accountId, error.code);
        this.logger.error(
          { event: 'sync.watch_unavailable', accountId, err: error },
          'Could not establish a Gmail watch; falling back to polling',
        );
        return;
      }

      // Anything else — a timeout, a 5xx, a rate limit — is worth retrying, and
      // the existing watch is still valid in the meantime. The failure is
      // recorded without touching either expiry: see recordRenewalFailure.
      await this.watches.recordRenewalFailure(userId, accountId, error.code).catch(() => undefined);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
