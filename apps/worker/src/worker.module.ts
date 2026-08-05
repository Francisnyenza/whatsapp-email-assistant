import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaService } from './common/prisma.service.js';
import { ThreadResolver } from './services/thread-resolver.js';
import { InboxRepository } from './repositories/inbox.repository.js';
import { ResponsePlanner } from './services/response-planner.js';
import { OutboundService } from './services/outbound.service.js';
import { CommandsProcessor } from './processors/commands.processor.js';

@Module({
  imports: [ConfigModule],
  providers: [
    PrismaService,
    InboxRepository,
    ThreadResolver,
    ResponsePlanner,
    OutboundService,
    CommandsProcessor,
  ],
})
export class WorkerModule {}
