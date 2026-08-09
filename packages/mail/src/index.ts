/** Public surface of @wea/mail. */

export {
  buildReplyHeaders,
  buildReplySubject,
  buildForwardSubject,
  stripReplyPrefixes,
  normalizeMessageId,
  parseReferences,
  trimReferences,
  generateMessageId,
  resolveReplyRecipients,
  type ThreadHeaders,
} from './threading.js';

export { buildForwardBody, type ForwardSource } from './forwarding.js';

export {
  composeMime,
  toGmailRaw,
  quoteOriginal,
  quoteOriginalHtml,
  formatAddress,
  formatAddressList,
  encodeHeaderValue,
  formatRfc2822Date,
  extractHeaderNames,
  escapeHtml,
  ALLOWED_HEADERS,
  type ComposeInput,
  type ComposedMessage,
} from './mime-builder.js';

export type { MailProvider, ProviderAccount, TokenRefreshCallback } from './provider.js';

export {
  normalizeGmailMessage,
  parseAddressList,
  parseSingleAddress,
  decodeEncodedWords,
  decodeBody,
  collectParts,
  htmlToText,
  findHeader,
  type GmailMessage,
  type GmailMessagePart,
} from './providers/gmail-normalize.js';

export { GmailProvider, GMAIL_SCOPES } from './providers/gmail.provider.js';
export { mapGmailError, isHistoryExpired, type GmailApiError } from './providers/gmail-errors.js';

export {
  normalizeGraphMessage,
  findGraphHeader,
  toEmailAddress,
  GRAPH_MESSAGE_SELECT,
  type GraphMessage,
  type GraphAttachment,
  type GraphRecipient,
} from './providers/graph-normalize.js';

export { GraphProvider, GRAPH_SCOPES } from './providers/graph.provider.js';
export {
  mapGraphError,
  isDeltaTokenExpired,
  type GraphApiError,
} from './providers/graph-errors.js';
