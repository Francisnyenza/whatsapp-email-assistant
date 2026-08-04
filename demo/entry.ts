// Entry point for the interactive demo.
//
// Everything re-exported here is the SAME compiled code the production workers
// run — imported from each package's dist/, not reimplemented for the browser.
export { parseCommand, needsConfirmation } from '../packages/whatsapp/dist/command-parser.js';
export {
  buildEmailNotification,
  buildDigest,
  buildSendConfirmation,
  buildDeleteConfirmation,
  buildDisambiguation,
  clamp,
} from '../packages/whatsapp/dist/builders.js';
export {
  evaluateWindow,
  decideDelivery,
  inQuietHours,
} from '../packages/whatsapp/dist/session-window.js';
export {
  buildReplyHeaders,
  resolveReplyRecipients,
  trimReferences,
  buildReplySubject,
} from '../packages/mail/dist/threading.js';
export {
  composeMime,
  quoteOriginal,
  extractHeaderNames,
  ALLOWED_HEADERS,
} from '../packages/mail/dist/mime-builder.js';
export { decodeActionPayload } from '../packages/shared/dist/utils/action-payload.js';
export { resolveLanguage } from '../packages/shared/dist/constants/languages.js';
