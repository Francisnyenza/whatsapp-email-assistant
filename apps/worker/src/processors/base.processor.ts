import { Worker, type Job, type Processor } from 'bullmq';
import { AppError, QUEUE_DEFAULTS, type QueueName } from '@wea/shared';
import type { Logger } from 'pino';
import { jobMetrics } from '../health/job-metrics.js';

/**
 * Shared wiring for every queue consumer.
 *
 * The behaviour that matters is the failure path. BullMQ retries anything that
 * throws, which is right for a provider timeout and wrong for a malformed
 * payload — retrying that four more times just burns quota and delays the
 * dead-letter. So a non-retryable AppError is marked unrecoverable and goes
 * straight to the DLQ, where it is visible and replayable.
 */
export function startWorker<T>(options: {
  queueName: QueueName;
  redisUrl: string;
  logger: Logger;
  handler: (job: Job<T>) => Promise<void>;
}): Worker<T> {
  const defaults = QUEUE_DEFAULTS[options.queueName];

  const processor: Processor<T> = async (job) => {
    const startedAt = Date.now();
    try {
      await options.handler(job);

      const ms = Date.now() - startedAt;
      jobMetrics.record({
        queue: options.queueName,
        job: job.name,
        outcome: 'completed',
        seconds: ms / 1_000,
      });

      options.logger.debug(
        { event: 'job.completed', queue: options.queueName, job: job.name, ms },
        'Job completed',
      );
    } catch (err) {
      const error = AppError.from(err);

      // Every failed *attempt*, not every lost job — a job that exhausts four
      // retries counts here four times and dead-letters once. The pair is the
      // point: this is the error rate, and an alert on dead-letters alone pages
      // only after the retries are spent.
      jobMetrics.record({
        queue: options.queueName,
        job: job.name,
        outcome: 'failed',
        seconds: (Date.now() - startedAt) / 1_000,
      });

      options.logger.error(
        {
          event: 'job.failed',
          queue: options.queueName,
          job: job.name,
          jobId: job.id,
          attempt: job.attemptsMade + 1,
          code: error.code,
          retryable: error.retryable,
          err: error,
        },
        'Job failed',
      );

      if (!error.retryable) {
        // Tells BullMQ to stop retrying. A malformed payload will be malformed
        // on the fourth attempt too.
        await job.discard();
      }
      throw error;
    }
  };

  const worker = new Worker<T>(options.queueName, processor, {
    connection: { url: options.redisUrl },
    concurrency: defaults.concurrency,
  });

  worker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? defaults.attempts)) {
      // Exhausted: work the system accepted and will not do. No duration — the
      // attempt that got here already recorded its own, and timing it twice
      // would count the same work twice in the histogram.
      jobMetrics.record({
        queue: options.queueName,
        job: job.name,
        outcome: 'dead_lettered',
      });

      // This is the line that should page someone.
      options.logger.error(
        { event: 'job.dead_lettered', queue: options.queueName, jobId: job.id, err: err.message },
        'Job exhausted its retries',
      );
    }
  });

  worker.on('error', (err) => {
    options.logger.error({ event: 'worker.error', queue: options.queueName, err }, 'Worker error');
  });

  return worker;
}
