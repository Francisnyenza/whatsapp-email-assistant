import { Controller, Get, Inject } from '@nestjs/common';
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
  async ready(): Promise<Record<string, unknown>> {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (err) {
      checks.database = 'unreachable';
      healthy = false;
      this.logger.error({ event: 'health.database_unreachable', err }, 'Database check failed');
    }

    try {
      await this.queue.depths();
      checks.queues = 'ok';
    } catch (err) {
      checks.queues = 'unreachable';
      healthy = false;
      this.logger.error({ event: 'health.redis_unreachable', err }, 'Queue check failed');
    }

    return { status: healthy ? 'ok' : 'degraded', checks };
  }
}
