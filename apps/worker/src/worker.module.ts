import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaService } from './common/prisma.service.js';
import { ThreadResolver } from './services/thread-resolver.js';
import { InboxRepository } from './repositories/inbox.repository.js';
import { ResponsePlanner } from './services/response-planner.js';
import { OutboundService } from './services/outbound.service.js';
import { AccountService } from './services/account.service.js';
import { MailboxActionService } from './services/mailbox-action.service.js';
import { ReplyComposer } from './services/reply-composer.js';
import { DraftRepository } from './repositories/draft.repository.js';
import { SendProcessor } from './processors/send.processor.js';
import { IngestProcessor } from './processors/ingest.processor.js';
import { NotifyProcessor } from './processors/notify.processor.js';
import { MessageRepository } from './repositories/message.repository.js';
import { QueueProducer } from './queue/queue.producer.js';
import { SyncScheduler } from './queue/sync.scheduler.js';
import { CommandsProcessor } from './processors/commands.processor.js';
import { SyncProcessor } from './processors/sync.processor.js';
import { WatchRepository } from './repositories/watch.repository.js';

@Module({
  imports: [ConfigModule],
  providers: [
    PrismaService,
    InboxRepository,
    ThreadResolver,
    ResponsePlanner,
    OutboundService,
    AccountService,
    MailboxActionService,
    ReplyComposer,
    DraftRepository,
    MessageRepository,
    WatchRepository,
    QueueProducer,
    SyncScheduler,
    CommandsProcessor,
    SendProcessor,
    IngestProcessor,
    NotifyProcessor,
    SyncProcessor,
  ],
})
export class WorkerModule {}
