import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { QueueModule } from './queue/queue.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { OAuthModule } from './oauth/oauth.module.js';
import { AccountsModule } from './accounts/accounts.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';
import { MetricsController } from './health/metrics.controller.js';
import { HttpMetrics } from './health/http-metrics.js';
import { HttpMetricsMiddleware } from './health/http-metrics.middleware.js';
import { RedisService } from './common/redis.service.js';
import { RateLimitMiddleware } from './common/rate-limit.middleware.js';
import { PrismaService } from './common/prisma.service.js';

@Module({
  imports: [ConfigModule, QueueModule, AuthModule, WebhooksModule, OAuthModule, AccountsModule],
  controllers: [HealthController, MetricsController],
  // `HttpMetricsMiddleware` is a provider here but is *not* wired with
  // `configure(consumer)`. Nest registers module middleware during `init`,
  // after every `app.use` in `bootstrap` has already been mounted — which would
  // put the timer behind the body parser, and a request rejected for malformed
  // JSON would never be measured. Those are exactly the 400s worth seeing on a
  // public webhook. `main.ts` mounts it first instead.
  providers: [
    PrismaService,
    HttpMetrics,
    HttpMetricsMiddleware,
    RedisService,
    // Wired by hand in main.ts alongside the metrics middleware, for the same
    // reason: order matters and `configure()` cannot express "before the body
    // parser".
    RateLimitMiddleware,
  ],
  exports: [PrismaService],
})
export class AppModule {}
