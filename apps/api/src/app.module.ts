import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { QueueModule } from './queue/queue.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { OAuthModule } from './oauth/oauth.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health/health.controller.js';
import { PrismaService } from './common/prisma.service.js';

@Module({
  imports: [ConfigModule, QueueModule, AuthModule, WebhooksModule, OAuthModule],
  controllers: [HealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
