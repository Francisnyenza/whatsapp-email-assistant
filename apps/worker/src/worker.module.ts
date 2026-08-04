import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaService } from './common/prisma.service.js';
import { ThreadResolver } from './services/thread-resolver.js';
import { CommandsProcessor } from './processors/commands.processor.js';

@Module({
  imports: [ConfigModule],
  providers: [PrismaService, ThreadResolver, CommandsProcessor],
})
export class WorkerModule {}
