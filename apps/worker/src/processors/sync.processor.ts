import { Injectable, Inject, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { Worker, Job } from 'bullmq';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB, type SweepWatchesJob, type RenewWatchJob } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { AccountService } from '../services/account.service.js';
import { WatchRepository } from '../repositories/watch.repository.js';
import { RetentionRepository } from '../repositories/retention.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';
import {
  RENEWAL_HORIZON_HOURS,
  SWEEP_BATCH_SIZE,
  PURGE_USER_BATCH,
  PURGE_ROWS_PER_USER,
  POLL_BATCH_SIZE,
  POLL_INTERVAL_MS,
  renewalJobId,
} from '../services/watch-schedule.js';
import {
  isDigestDue,
  DIGEST_USER_BATCH,
  DIGEST_SWEEP_INTERVAL_MS,
} from '../services/digest-schedule.js';
import { startWorker } from './base.processor.js';

type SyncJob = SweepWatchesJob | RenewWatchJob;

/**
 * The work the system does on its own behalf: keeping mailboxes subscribed, and
 * erasing what it promised not to keep.
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
 *
 * The polling sweep is the counterweight to the renewal one. Renewal tries to
 * keep every mailbox on push; polling is what keeps mail flowing to the ones
 * that, for now, are not — because "we tried to set up a watch and could not"
 * must not mean "you receive nothing".
 *
 * The retention purge is the third job, and it is here for the same reason: it
 * runs on a timer with no tenant, and it solves that the same way — enumerate
 * from a table with nothing secret in it, then do the erasing scoped, under the
 * policy, exactly as a request would.
 */
@Injectable()
export class SyncProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker<SyncJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly accounts: AccountService,
    private readonly watches: WatchRepository,
    private readonly retention: RetentionRepository,
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
      case JOB.PURGE_EXPIRED:
        return this.purge();
      case JOB.SWEEP_DIGESTS:
        return this.sweepDigests();
      case JOB.SWEEP_POLLING:
        return this.sweepPolling();
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

  /**
   * Erases message bodies past their retention window.
   *
   * This is the other half of storing them at all. A body kept indefinitely is a
   * body that will eventually be in a breach, and the promise the product makes
   * — and that `RETENTION_BODY_DAYS` states — is that it is not kept. A purge
   * that never runs turns that promise into a comment.
   *
   * Bounded per user and per run so one enormous mailbox cannot starve the rest
   * and so a sweep cannot hold a transaction open for minutes. What is left over
   * is caught by the next run, because the window only moves forward.
   */
  private async purge(): Promise<void> {
    const olderThan = new Date(Date.now() - this.config.env.RETENTION_BODY_DAYS * 24 * 3_600_000);

    let purged = 0;
    let users = 0;
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.retention.findUserIds(PURGE_USER_BATCH, cursor);
      if (batch.length === 0) break;

      for (const userId of batch) {
        purged += await this.retention.purgeBodies(userId, olderThan, PURGE_ROWS_PER_USER);
        users++;
      }

      cursor = batch.at(-1);
      if (batch.length < PURGE_USER_BATCH) break;
    }

    this.logger.info(
      {
        event: 'sync.purge_completed',
        users,
        purged,
        retentionDays: this.config.env.RETENTION_BODY_DAYS,
      },
      'Retention sweep completed',
    );
  }

  /**
   * Syncs mailboxes that have no push subscription.
   *
   * Push is the product; this is what happens when it cannot be arranged — a
   * Pub/Sub misconfiguration, a Google outage during linking, a watch that
   * failed its renewals. Without it `pollingSince` is a column nobody reads and
   * such an account receives nothing at all until a watch happens to succeed.
   *
   * A null expiry on the route is exactly the condition, so this needs no extra
   * state and stops on its own the moment a watch is established.
   *
   * The job it enqueues is the ordinary ingest job. Now that ingest resumes from
   * the stored cursor rather than one handed to it, polling and push are the
   * same code path reached two different ways — which is the only reason this is
   * a dozen lines rather than a second pipeline.
   */
  private async sweepPolling(): Promise<void> {
    const now = Date.now();
    const unwatched = await this.watches.findWithoutWatch(POLL_BATCH_SIZE);

    for (const account of unwatched) {
      await this.queue.enqueue(
        QUEUE.INGEST,
        JOB.PROCESS_CHANGE,
        {
          userId: account.userId,
          accountId: account.accountId,
          // Ingest ignores this and resumes from what it stored; it is carried
          // because the job's shape requires it and it makes the log honest
          // about which sweep produced the sync.
          cursor: 'poll',
        },
        // One sync per account per interval, however many sweeps overlap.
        { jobId: `poll:${account.accountId}:${Math.floor(now / POLL_INTERVAL_MS)}` },
      );
    }

    this.logger.info(
      {
        event: 'sync.poll_sweep_completed',
        polled: unwatched.length,
        saturated: unwatched.length === POLL_BATCH_SIZE,
      },
      'Polled mailboxes without a push subscription',
    );
  }

  /**
   * Finds users whose scheduled digest is due and enqueues one each.
   *
   * The other half of deferral. A user in digest mode, or one who simply has
   * not messaged us, accumulates held-back mail that nothing would otherwise
   * deliver — "deferred" would just be a politer word for dropped.
   *
   * Per-user rather than one cross-tenant query, because `email_messages` is
   * under row-level security and the alternative is a scheduled job that can
   * read every mailbox. Users with nothing waiting are skipped on a single
   * indexed count.
   */
  private async sweepDigests(): Promise<void> {
    const now = new Date();
    let due = 0;
    let examined = 0;
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.retention.findUserIds(DIGEST_USER_BATCH, cursor);
      if (batch.length === 0) break;

      for (const userId of batch) {
        examined++;
        const candidate = await this.retention.digestCandidate(userId);
        if (!candidate) continue;

        if (
          !isDigestDue({
            times: candidate.digestTimes,
            timezone: candidate.timezone,
            lastDigestAt: candidate.lastDigestAt,
            now,
          })
        ) {
          continue;
        }

        due++;
        await this.queue.enqueue(
          QUEUE.NOTIFY,
          JOB.SEND_DIGEST,
          { userId },
          // Bucketed per sweep interval so two ticks cannot both fire while the
          // first digest is still in flight.
          { jobId: `digest:${userId}:${Math.floor(now.getTime() / DIGEST_SWEEP_INTERVAL_MS)}` },
        );
      }

      cursor = batch.at(-1);
      if (batch.length < DIGEST_USER_BATCH) break;
    }

    this.logger.info(
      { event: 'sync.digest_sweep_completed', examined, due },
      'Digest sweep completed',
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
