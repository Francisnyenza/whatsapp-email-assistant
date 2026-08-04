import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { QueueModule } from './queue/queue.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { HealthController } from './health/health.controller.js';
import { PrismaService } from './common/prisma.service.js';

@Module({
  imports: [ConfigModule, QueueModule, WebhooksModule],
  controllers: [HealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
