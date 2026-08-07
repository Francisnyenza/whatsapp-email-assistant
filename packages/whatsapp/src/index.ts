/** Public surface of @wea/whatsapp. */

export {
  evaluateWindow,
  isWindowOpen,
  decideDelivery,
  inQuietHours,
  type SendMode,
  type SessionState,
  type WindowDecision,
  type DeliveryPreferences,
  type DeliveryCandidate,
  type DeliveryAction,
  type NotificationMode,
} from './session-window.js';

export {
  parseWebhook,
  webhookDedupeKey,
  handleVerificationChallenge,
  whatsappWebhookSchema,
  type ParsedWebhook,
  type WhatsAppWebhookPayload,
} from './webhook.js';

export {
  buildEmailNotification,
  buildDigest,
  buildSendConfirmation,
  buildDeleteConfirmation,
  buildDisambiguation,
  buildText,
  enforceLimits,
  clamp,
  type EmailNotificationInput,
  type DigestItem,
} from './builders.js';

export { WhatsAppClient, serializePayload, type WhatsAppClientOptions } from './client.js';

export { parseCommand, needsConfirmation, type ParseResult } from './command-parser.js';

export {
  TEMPLATES,
  buildTemplate,
  buildNewEmailTemplate,
  buildDigestTemplate,
  templateParameter,
  resolveTemplateLanguage,
  type TemplateDefinition,
} from './templates.js';
