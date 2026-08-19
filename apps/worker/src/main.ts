import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import { WorkerModule } from './worker.module.js';
import { ConfigService } from './config/config.service.js';
import { PrismaService } from './common/prisma.service.js';
import { QueueProducer } from './queue/queue.producer.js';
import { startHealthServer } from './health/health.server.js';

/**
 * The worker runtime.
 *
 * A standalone application context rather than an HTTP app: nothing calls this,
 * it consumes queues. The one exception is a two-route health listener, and it
 * earns its place — without it the Deployment has no probes at all, and a
 * worker whose Redis connection has died stays in the deployment consuming
 * nothing while looking perfectly healthy. It is `node:http` rather than a
 * second Nest app, for the reasons in `health/health.server.ts`.
 */
async function bootstrap(): Promise<void> {
  // `abortOnError: false` for the same reason as the API: otherwise Nest exits
  // the process itself on a start-up failure, before the handler at the bottom
  // of this file runs, and with `logger: false` suppressing the reason — a
  // worker that dies at boot having printed nothing.
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
    abortOnError: false,
  });

  const config = app.get(ConfigService);
  const logger = app.get<Logger>('LOGGER');
  const prisma = app.get(PrismaService);
  const queue = app.get(QueueProducer);

  const health = startHealthServer({
    port: config.env.WORKER_PORT,
    checks: {
      database: () => prisma.$queryRaw`SELECT 1`,
      queues: () => queue.depths(),
    },
    onError: (event, err) => logger.error({ event, err }, 'Health check failed'),
  });

  // Kubernetes sends SIGTERM then waits. Closing the workers lets in-flight
  // jobs finish; killing them mid-send is how a reply gets sent twice.
  app.enableShutdownHooks();

  // The listener closes first, and on purpose. A draining worker that keeps
  // answering "ready" is one Kubernetes keeps routing work to — which defeats
  // the grace period that exists so it can finish the work it already has.
  const stopHealth = (): void => {
    health.close();
  };
  process.once('SIGTERM', stopHealth);
  process.once('SIGINT', stopHealth);

  logger.info(
    { event: 'worker.started', env: config.env.NODE_ENV, healthPort: config.env.WORKER_PORT },
    'Worker started',
  );
}

bootstrap().catch((err) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
