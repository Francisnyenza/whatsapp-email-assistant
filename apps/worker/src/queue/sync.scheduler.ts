import { Injectable, Inject, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { QUEUE, JOB } from '@wea/shared';
import { QueueProducer } from './queue.producer.js';
import {
  SWEEP_INTERVAL_MS,
  PURGE_INTERVAL_MS,
  POLL_INTERVAL_MS,
} from '../services/watch-schedule.js';
import { DIGEST_SWEEP_INTERVAL_MS } from '../services/digest-schedule.js';

/** Scheduler identities. Stable, because changing one leaves the old schedule running. */
const WATCH_SWEEP_ID = 'watch-renewal-sweep';
const RETENTION_SWEEP_ID = 'retention-sweep';
const DIGEST_SWEEP_ID = 'digest-sweep';
const POLL_SWEEP_ID = 'polling-sweep';

/**
 * The clock.
 *
 * Registers the recurring work the system does on its own behalf: sweeping for
 * Gmail watches about to lapse, and erasing message bodies past their retention
 * window.
 *
 * It lives in the worker rather than the API because the API is meant to be
 * stateless and horizontally trivial — a scheduler there would tie the timer's
 * survival to whichever replica happened to be up. BullMQ's job scheduler keeps
 * the schedule in Redis, so every replica upserting the same id converges on
 * one timer, and losing a replica loses nothing.
 *
 * Registration failing must not stop the worker. A worker that consumes queues
 * but has no timer still delivers mail; a worker that refuses to boot delivers
 * none.
 */
@Injectable()
export class SyncScheduler implements OnModuleInit {
  constructor(
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.register(
      WATCH_SWEEP_ID,
      SWEEP_INTERVAL_MS,
      JOB.SWEEP_WATCHES,
      'mailbox subscriptions will lapse',
    );

    await this.register(
      RETENTION_SWEEP_ID,
      PURGE_INTERVAL_MS,
      JOB.PURGE_EXPIRED,
      'message bodies will be kept past their retention window',
    );

    await this.register(
      DIGEST_SWEEP_ID,
      DIGEST_SWEEP_INTERVAL_MS,
      JOB.SWEEP_DIGESTS,
      'deferred mail will never be delivered',
    );

    await this.register(
      POLL_SWEEP_ID,
      POLL_INTERVAL_MS,
      JOB.SWEEP_POLLING,
      'mailboxes without a push subscription will receive nothing',
    );
  }

  /**
   * `consequence` is what goes in the log when registration fails, because
   * "scheduler.registration_failed" on its own tells an operator nothing about
   * what is now quietly not happening.
   */
  private async register(
    id: string,
    everyMs: number,
    job: (typeof JOB)[keyof typeof JOB],
    consequence: string,
  ): Promise<void> {
    try {
      await this.queue.schedule(QUEUE.SYNC, id, everyMs, job, {});

      this.logger.info(
        { event: 'scheduler.registered', schedule: id, everyMs },
        'Recurring job scheduled',
      );
    } catch (err) {
      this.logger.error(
        { event: 'scheduler.registration_failed', schedule: id, err },
        `Could not register ${id}; ${consequence}`,
      );
    }
  }
}
