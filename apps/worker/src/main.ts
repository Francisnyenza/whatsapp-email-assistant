import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import { WorkerModule } from './worker.module.js';
import { ConfigService } from './config/config.service.js';

/**
 * The worker runtime.
 *
 * Created as a standalone application context — no HTTP server, because nothing
 * calls this. It consumes queues and exits when told to.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });

  const config = app.get(ConfigService);
  const logger = app.get<Logger>('LOGGER');

  // Kubernetes sends SIGTERM then waits. Closing the workers lets in-flight
  // jobs finish; killing them mid-send is how a reply gets sent twice.
  app.enableShutdownHooks();

  logger.info({ event: 'worker.started', env: config.env.NODE_ENV }, 'Worker started');
}

bootstrap().catch((err) => {
  console.error('Worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
