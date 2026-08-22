import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { AppModule } from './app.module.js';
import { ConfigService } from './config/config.service.js';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { jsonWithRawBody } from './common/raw-body.js';
import { HttpMetricsMiddleware } from './health/http-metrics.middleware.js';
import { RateLimitMiddleware } from './common/rate-limit.middleware.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger would bypass our redaction, so it is disabled and every
    // line goes through the pino instance instead.
    logger: false,
    // Without this, Nest catches a start-up failure itself and calls
    // `process.exit(1)` from inside its exception zone — before the `catch`
    // below ever runs, and with the reason routed to the logger disabled on the
    // line above. The result was a process that died at boot printing nothing
    // at all, which hid a dependency-injection bug that made the API
    // unstartable. `false` makes `create` reject instead, so the handler at the
    // bottom of this file gets the error and writes it where a person can see
    // it.
    abortOnError: false,
    // We install our own body parser, because webhook signature verification
    // needs the raw bytes and the default parser discards them.
    bodyParser: false,
  });

  const config = app.get(ConfigService);
  const logger = app.get<Logger>('LOGGER');

  // First, and deliberately ahead of everything else. It measures on the way
  // out rather than on the way in, so anything mounted after it is inside what
  // it times — including the body parser, whose rejections are otherwise the
  // one class of 4xx no metric can see.
  const metrics = app.get(HttpMetricsMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => metrics.use(req, res, next));

  // Second: inside the metrics, so a 429 is counted like any other response,
  // and ahead of the body parser, so a flood is rejected before its payload is
  // read into memory.
  const rateLimit = app.get(RateLimitMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => rateLimit.use(req, res, next));

  app.use(jsonWithRawBody());

  app.use(
    helmet({
      // The API serves JSON, never markup, so the restrictive defaults are
      // exactly right and CSP has nothing to relax for.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
    }),
  );

  app.enableCors({
    origin: [config.env.WEB_BASE_URL],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  app.useGlobalFilters(new AllExceptionsFilter(logger));

  // Kubernetes sends SIGTERM and then waits: finish in-flight requests rather
  // than dropping them.
  app.enableShutdownHooks();

  await app.listen(config.env.API_PORT);
  logger.info(
    { event: 'api.started', port: config.env.API_PORT, env: config.env.NODE_ENV },
    'API listening',
  );
}

bootstrap().catch((err) => {
  // The logger may not exist yet — a bad environment fails before the container
  // is built — so this one case writes directly to stderr.
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
