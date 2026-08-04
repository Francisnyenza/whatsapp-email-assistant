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
