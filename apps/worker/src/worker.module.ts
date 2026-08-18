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
import { ForwardComposer } from './services/forward-composer.js';
import { AttachmentStagingService } from './services/attachment-staging.service.js';
import { LabelService } from './services/label.service.js';
import { SnoozeService } from './services/snooze.service.js';
import { UndoService } from './services/undo.service.js';
import { MailboxPickerService } from './services/mailbox-picker.service.js';
import { RecipientResolverService } from './services/recipient-resolver.service.js';
import { TranscriptionService } from './services/transcription.service.js';
import { ComposeComposer } from './services/compose-composer.js';
import { MediaProcessor } from './processors/media.processor.js';
import { AttachmentRepository } from './repositories/attachment.repository.js';
import { DraftRepository } from './repositories/draft.repository.js';
import { StagedAttachmentRepository } from './repositories/staged-attachment.repository.js';
import { ReminderRepository } from './repositories/reminder.repository.js';
import { SendProcessor } from './processors/send.processor.js';
import { IngestProcessor } from './processors/ingest.processor.js';
import { NotifyProcessor } from './processors/notify.processor.js';
import { MessageRepository } from './repositories/message.repository.js';
import { ContactRepository } from './repositories/contact.repository.js';
import { QueueProducer } from './queue/queue.producer.js';
import { SyncScheduler } from './queue/sync.scheduler.js';
import { CommandsProcessor } from './processors/commands.processor.js';
import { SyncProcessor } from './processors/sync.processor.js';
import { WatchRepository } from './repositories/watch.repository.js';
import { RetentionRepository } from './repositories/retention.repository.js';
import { AnalysisRepository } from './repositories/analysis.repository.js';
import { AiService } from './services/ai.service.js';
import { AiProcessor } from './processors/ai.processor.js';
import { SearchRepository } from './repositories/search.repository.js';
import { MailboxQueryService } from './services/mailbox-query.service.js';
import { AssistantService } from './services/assistant.service.js';

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
    ForwardComposer,
    AttachmentStagingService,
    LabelService,
    SnoozeService,
    UndoService,
    MailboxPickerService,
    RecipientResolverService,
    TranscriptionService,
    ComposeComposer,
    MediaProcessor,
    AttachmentRepository,
    DraftRepository,
    StagedAttachmentRepository,
    ReminderRepository,
    MessageRepository,
    ContactRepository,
    WatchRepository,
    RetentionRepository,
    AnalysisRepository,
    SearchRepository,
    AiService,
    MailboxQueryService,
    AssistantService,
    QueueProducer,
    SyncScheduler,
    CommandsProcessor,
    SendProcessor,
    IngestProcessor,
    NotifyProcessor,
    SyncProcessor,
    AiProcessor,
  ],
})
export class WorkerModule {}
