import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../common/prisma.service.js';
import { QueueProducer } from '../queue/queue.producer.js';
import type { Logger } from 'pino';

/**
 * Two endpoints, two different questions.
 *
 * `/health/live` asks "is this process alive?" — nothing else. A liveness probe
 * that checks the database will restart every pod during a database blip,
 * turning a degradation into an outage.
 *
 * `/health/ready` asks "should traffic come here?" and does check dependencies,
 * because a pod that cannot reach Postgres should be taken out of rotation
 * rather than serving errors.
 */

/**
 * How long a dependency gets to answer before it counts as unreachable.
 *
 * Without a bound this endpoint did not fail when Redis was down — it *hung*,
 * holding the connection open indefinitely. A probe that hangs is
 * indistinguishable from one that fails, except that it accumulates sockets
 * while it waits, and anyone curling it during an incident learns nothing at
 * all. The worker's own health listener has always bounded its probes; this is
 * the same reasoning applied where it was missing.
 *
 * Three seconds is well past a healthy round trip to either dependency and well
 * inside any sensible probe timeout.
 */
export const READY_CHECK_TIMEOUT_MS = 3_000;

/** Resolves with the work, or rejects once the deadline passes. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    // The loser of the race is still pending. Clearing the timer is what stops
    // it holding the event loop open after the response has gone.
    if (timer) clearTimeout(timer);
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  @Get('live')
  live(): { status: string; uptime: number } {
    return { status: 'ok', uptime: Math.floor(process.uptime()) };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    // Both at once. Sequentially, a database that takes the full timeout to
    // fail delays the Redis answer behind it — and it is the two together that
    // say which system is actually broken.
    const [database, queues] = await Promise.allSettled([
      withDeadline(Promise.resolve(this.prisma.$queryRaw`SELECT 1`), READY_CHECK_TIMEOUT_MS),
      withDeadline(this.queue.depths(), READY_CHECK_TIMEOUT_MS),
    ]);

    const checks: Record<string, string> = {};
    let healthy = true;

    if (database.status === 'fulfilled') {
      checks.database = 'ok';
    } else {
      checks.database = 'unreachable';
      healthy = false;
      this.logger.error(
        { event: 'health.database_unreachable', err: database.reason },
        'Database check failed',
      );
    }

    if (queues.status === 'fulfilled') {
      checks.queues = 'ok';
    } else {
      checks.queues = 'unreachable';
      healthy = false;
      this.logger.error(
        { event: 'health.redis_unreachable', err: queues.reason },
        'Queue check failed',
      );
    }

    // 503, not a 200 carrying `status: "degraded"`. A readiness probe reads the
    // status code and nothing else, so the body was being written for a reader
    // that does not exist while Kubernetes kept routing traffic to a pod that
    // had just declared itself broken.
    if (!healthy) res.status(503);

    return { status: healthy ? 'ok' : 'degraded', checks };
  }
}
