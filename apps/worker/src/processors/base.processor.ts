import { Worker, type Job, type Processor } from 'bullmq';
import { AppError, QUEUE_DEFAULTS, type QueueName } from '@wea/shared';
import type { Logger } from 'pino';

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
      options.logger.debug(
        {
          event: 'job.completed',
          queue: options.queueName,
          job: job.name,
          ms: Date.now() - startedAt,
        },
        'Job completed',
      );
    } catch (err) {
      const error = AppError.from(err);

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
      // Exhausted. This is the line that should page someone.
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
