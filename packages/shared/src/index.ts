/** Public surface of @wea/shared. Everything else in the package is internal. */

// config
export { envSchema, loadEnv, type Env } from './config/env.schema.js';

// domain types
export type {
  MailProviderKind,
  EmailAddress,
  EmailAttachment,
  AttachmentDisposition,
  NormalizedMessage,
  OutboundMessage,
  OutboundAttachment,
  SendResult,
  MailOperation,
  ChangeEvent,
  SyncCursor,
  WatchHandle,
  EmailCategory,
  EmailPriority,
} from './types/email.js';

export type {
  WhatsAppMessageType,
  InboundWhatsAppMessage,
  WhatsAppDeliveryStatus,
  WhatsAppStatusUpdate,
  WhatsAppButton,
  WhatsAppTextPayload,
  WhatsAppButtonsPayload,
  WhatsAppListPayload,
  WhatsAppListSection,
  WhatsAppMediaPayload,
  WhatsAppTemplatePayload,
  WhatsAppOutboundPayload,
  WhatsAppSendResult,
} from './types/whatsapp.js';
export { WHATSAPP_LIMITS } from './types/whatsapp.js';

export {
  emailAnalysisSchema,
  emailCategorySchema,
  emailPrioritySchema,
  extractedEntitySchema,
  actionItemSchema,
  draftedReplySchema,
  commandIntentSchema,
  DESTRUCTIVE_INTENTS,
  type EmailAnalysis,
  type ExtractedEntity,
  type ActionItem,
  type DraftedReply,
  type CommandIntent,
  type CommandIntentName,
  type AiTaskClass,
  type AiUsage,
  type AiResult,
} from './types/ai.js';

// constants
export {
  QUEUE,
  JOB,
  QUEUE_DEFAULTS,
  type QueueName,
  type JobName,
  type QueueDefaults,
  type ProcessChangeJob,
  type DeliverAttachmentJob,
  type AnalyzeEmailJob,
  type NotifyEmailJob,
  type SendEmailJob,
  type SweepWatchesJob,
  type RenewWatchJob,
  type HandleInboundJob,
} from './constants/queues.js';

export {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_CODES,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  getLanguage,
  resolveLanguage,
  type SupportedLanguage,
} from './constants/languages.js';

export {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  STAGED_ATTACHMENT_TTL_MS,
} from './constants/attachments.js';

// errors
export { AppError, type ErrorCode, type AppErrorOptions } from './errors/app-error.js';

// utils
export { redact, redactString, maskEmail, maskPhone, fingerprint } from './utils/redact.js';

export {
  encodeActionPayload,
  decodeActionPayload,
  requiresConfirmation,
  ACTION_PAYLOAD_PREFIX,
  MAX_PAYLOAD_LENGTH,
  type ActionPayload,
  type PayloadAction,
} from './utils/action-payload.js';

export { normalizePhone, isE164, toWhatsAppFormat, fromWhatsAppFormat } from './utils/phone.js';
