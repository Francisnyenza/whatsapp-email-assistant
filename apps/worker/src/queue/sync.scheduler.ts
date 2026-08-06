import { Injectable, Inject, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { QUEUE, JOB } from '@wea/shared';
import { QueueProducer } from './queue.producer.js';
import { SWEEP_INTERVAL_MS } from '../services/watch-schedule.js';

/** The scheduler's identity. Stable, because changing it would leave the old schedule running. */
const WATCH_SWEEP_ID = 'watch-renewal-sweep';

/**
 * The clock.
 *
 * Registers the recurring work the system does on its own behalf. Today that is
 * one job: sweeping for Gmail watches about to lapse.
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
    try {
      await this.queue.schedule(
        QUEUE.SYNC,
        WATCH_SWEEP_ID,
        SWEEP_INTERVAL_MS,
        JOB.SWEEP_WATCHES,
        {},
      );

      this.logger.info(
        { event: 'scheduler.registered', schedule: WATCH_SWEEP_ID, everyMs: SWEEP_INTERVAL_MS },
        'Watch renewal sweep scheduled',
      );
    } catch (err) {
      this.logger.error(
        { event: 'scheduler.registration_failed', schedule: WATCH_SWEEP_ID, err },
        'Could not register the watch renewal sweep; mailbox subscriptions will lapse',
      );
    }
  }
}
