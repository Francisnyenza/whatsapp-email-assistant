import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { QUEUE, QUEUE_DEFAULTS, type QueueName, type JobName } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';

/**
 * The API's only write path into the pipeline.
 *
 * The API never processes anything itself — it validates, enqueues and returns.
 * That is what keeps a webhook acknowledgement under 50 ms regardless of how
 * slow Gmail, an LLM provider or Meta happen to be.
 */
@Injectable()
export class QueueProducer implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly config: ConfigService) {}

  async enqueue(
    queueName: QueueName,
    jobName: JobName,
    payload: unknown,
    options: JobsOptions = {},
  ): Promise<void> {
    const defaults = QUEUE_DEFAULTS[queueName];

    await this.queue(queueName).add(jobName, payload, {
      attempts: defaults.attempts,
      backoff: { type: 'exponential', delay: defaults.backoffMs },
      removeOnComplete: { count: defaults.removeOnCompleteCount },
      // Failures are kept so a dead-letter is inspectable and replayable from
      // the admin panel. A dropped email is a product failure, not a log line.
      removeOnFail: { count: defaults.removeOnFailCount },
      ...options,
    });
  }

  /**
   * Registers a job that repeats on a fixed interval.
   *
   * Upsert rather than add, because every worker replica calls this on boot and
   * they must converge on one schedule rather than one per replica. Changing the
   * interval in code is enough to move it — the scheduler id, not the interval,
   * is the identity.
   */
  async schedule(
    queueName: QueueName,
    schedulerId: string,
    everyMs: number,
    jobName: JobName,
    payload: unknown = {},
  ): Promise<void> {
    const defaults = QUEUE_DEFAULTS[queueName];

    await this.queue(queueName).upsertJobScheduler(
      schedulerId,
      { every: everyMs },
      {
        name: jobName,
        data: payload,
        opts: {
          attempts: defaults.attempts,
          backoff: { type: 'exponential', delay: defaults.backoffMs },
          removeOnComplete: { count: defaults.removeOnCompleteCount },
          removeOnFail: { count: defaults.removeOnFailCount },
        },
      },
    );
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: { url: this.config.env.REDIS_QUEUE_URL ?? this.config.env.REDIS_URL },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Reports queue depth for the health endpoint and the admin panel. */
  async depths(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      Object.values(QUEUE).map(async (name) => {
        const counts = await this.queue(name).getJobCounts('waiting', 'active', 'failed');
        return [name, (counts.waiting ?? 0) + (counts.active ?? 0)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
