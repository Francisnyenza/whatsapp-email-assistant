import type { EmailAddress, EmailAttachment, NormalizedMessage } from '@wea/shared';
import { normalizeMessageId, parseReferences } from '../threading.js';

/**
 * Turning Gmail's `users.messages.get` payload into our normalized shape.
 *
 * Separated from the API client so it can be tested exhaustively against real
 * payload shapes without a network — which matters, because Gmail's MIME trees
 * are more varied than the documentation suggests: nested `multipart/related`
 * inside `multipart/alternative` inside `multipart/mixed`, inline images with
 * `Content-ID`, parts with no MIME type at all, and bodies that arrive only as
 * an `attachmentId` when large.
 */

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
}

/** Header lookup is case-insensitive: Gmail preserves the sender's casing. */
export function findHeader(part: GmailMessagePart | undefined, name: string): string | undefined {
  if (!part?.headers) return undefined;
  const lower = name.toLowerCase();
  return part.headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/**
 * Parses an address list header.
 *
 * Handles the forms that actually arrive: bare addresses, `Name <addr>`, quoted
 * names containing commas (`"Chen, Sarah" <s@acme.com>`), and RFC 2047
 * encoded-words. Splitting naively on commas breaks the third form, which is
 * common in corporate mail.
 */
export function parseAddressList(header: string | undefined): EmailAddress[] {
  if (!header?.trim()) return [];

  const results: EmailAddress[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  const flush = () => {
    const parsed = parseSingleAddress(current);
    if (parsed) results.push(parsed);
    current = '';
  };

  for (const char of header) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '<') inAngle = true;
    else if (char === '>') inAngle = false;

    if (char === ',' && !inQuotes && !inAngle) flush();
    else current += char;
  }
  flush();

  return results;
}

export function parseSingleAddress(raw: string): EmailAddress | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const angled = /^(.*?)<([^>]+)>\s*$/.exec(trimmed);
  if (angled) {
    const name = decodeEncodedWords(angled[1]!.trim().replace(/^"|"$/g, '').trim());
    const address = angled[2]!.trim().toLowerCase();
    if (!address.includes('@')) return null;
    return name ? { name, address } : { address };
  }

  const address = trimmed.toLowerCase();
  return address.includes('@') ? { address } : null;
}

/**
 * Decodes RFC 2047 encoded-words.
 *
 * Without this, a sender called "José" shows up in a WhatsApp notification as
 * `=?UTF-8?B?Sm9zw6k=?=`, which is the first thing a user would report.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes('=?')) return value;

  return (
    value
      // Adjacent encoded-words are joined without the whitespace between them.
      .replace(/\?=\s+=\?/g, '?==?')
      .replace(
        /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
        (match, charset: string, encoding: string, text: string) => {
          let buffer: Buffer;

          if (encoding.toUpperCase() === 'B') {
            // Buffer.from(_, 'base64') does not throw on invalid input — it
            // silently discards the bad characters and returns garbage. Validating
            // the syntax first is the only way to detect a malformed word.
            if (!/^[A-Za-z0-9+/\s]*={0,2}$/.test(text)) return match;
            buffer = Buffer.from(text, 'base64');
          } else {
            buffer = Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                ),
              'binary',
            );
          }

          const normalized = charset.toLowerCase();
          if (normalized === 'iso-8859-1' || normalized === 'latin1') {
            return buffer.toString('latin1');
          }

          const decoded = buffer.toString('utf8');
          // Replacement characters mean the bytes were not the charset claimed.
          // Showing the raw encoded-word is less confusing than mojibake, and
          // keeps the sender's name recoverable by eye.
          return decoded.includes('�') ? match : decoded;
        },
      )
  );
}

/** Gmail returns body data as base64url. */
export function decodeBody(data: string | undefined): string {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

interface CollectedParts {
  text: string;
  html: string;
  attachments: EmailAttachment[];
}

/**
 * Walks the MIME tree.
 *
 * Depth is bounded: a maliciously nested message should not blow the stack, and
 * no legitimate mail nests more than a few levels.
 */
export function collectParts(part: GmailMessagePart | undefined, depth = 0): CollectedParts {
  const collected: CollectedParts = { text: '', html: '', attachments: [] };
  if (!part || depth > 20) return collected;

  const mimeType = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';
  const contentDisposition = findHeader(part, 'content-disposition') ?? '';
  const contentId = findHeader(part, 'content-id')?.replace(/^<|>$/g, '');

  // A part with a filename or an attachmentId is content, not body — even when
  // its MIME type is text/plain, which is how .txt attachments arrive.
  const isAttachment =
    Boolean(filename) ||
    /attachment/i.test(contentDisposition) ||
    (Boolean(part.body?.attachmentId) && !mimeType.startsWith('multipart/'));

  if (isAttachment && part.body?.attachmentId) {
    collected.attachments.push({
      providerAttachmentId: part.body.attachmentId,
      filename: decodeEncodedWords(filename || 'attachment'),
      mimeType: mimeType || 'application/octet-stream',
      sizeBytes: part.body.size ?? 0,
      disposition: /inline/i.test(contentDisposition) ? 'inline' : 'attachment',
      ...(contentId ? { contentId } : {}),
    });
    return collected;
  }

  if (mimeType === 'text/plain' && !isAttachment) {
    collected.text += decodeBody(part.body?.data);
    return collected;
  }

  if (mimeType === 'text/html' && !isAttachment) {
    collected.html += decodeBody(part.body?.data);
    return collected;
  }

  for (const child of part.parts ?? []) {
    const childResult = collectParts(child, depth + 1);
    collected.text += childResult.text;
    collected.html += childResult.html;
    collected.attachments.push(...childResult.attachments);
  }

  return collected;
}

/**
 * A crude HTML-to-text fallback, used only when a message has no `text/plain`
 * part at all — increasingly common with marketing mail.
 *
 * This is not a renderer. It exists so the AI summarizer and the WhatsApp
 * snippet have something readable rather than raw markup.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeGmailMessage(message: GmailMessage): NormalizedMessage {
  const payload = message.payload;
  const { text, html, attachments } = collectParts(payload);

  const bodyText = text.trim() || (html ? htmlToText(html) : '');

  const from = parseSingleAddress(findHeader(payload, 'from') ?? '') ?? { address: 'unknown@' };
  const replyTo = parseSingleAddress(findHeader(payload, 'reply-to') ?? '');

  const labels = message.labelIds ?? [];

  // Gmail's internalDate is the authoritative arrival time; the Date header is
  // whatever the sender's clock said, and is frequently wrong.
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : new Date();

  const dateHeader = findHeader(payload, 'date');
  const sentAt = dateHeader ? safeParseDate(dateHeader, receivedAt) : receivedAt;

  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    messageIdHeader: normalizeMessageId(findHeader(payload, 'message-id')),
    ...(findHeader(payload, 'in-reply-to')
      ? { inReplyTo: normalizeMessageId(findHeader(payload, 'in-reply-to')) }
      : {}),
    references: parseReferences(findHeader(payload, 'references')),

    subject: decodeEncodedWords(findHeader(payload, 'subject') ?? ''),
    from,
    ...(replyTo ? { replyTo } : {}),
    to: parseAddressList(findHeader(payload, 'to')),
    cc: parseAddressList(findHeader(payload, 'cc')),
    bcc: parseAddressList(findHeader(payload, 'bcc')),

    sentAt,
    receivedAt,

    bodyText,
    ...(html ? { bodyHtml: html } : {}),
    snippet: (message.snippet ? decodeHtmlEntities(message.snippet) : bodyText).slice(0, 200),

    attachments,

    isUnread: labels.includes('UNREAD'),
    isStarred: labels.includes('STARRED'),
    isDraft: labels.includes('DRAFT'),
    labels,
    sizeBytes: message.sizeEstimate ?? 0,
  };
}

/** Gmail HTML-escapes its snippets. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function safeParseDate(value: string, fallback: Date): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;

  // A sender's clock can be years out. Anything absurd is not trusted for
  // ordering, which would otherwise put a spam message permanently at the top.
  const skewLimit = 365 * 24 * 3_600_000;
  if (Math.abs(parsed.getTime() - fallback.getTime()) > skewLimit) return fallback;
  return parsed;
}
