import { randomBytes } from 'node:crypto';
import { AppError, type EmailAddress, type OutboundAttachment } from '@wea/shared';
import { generateMessageId } from './threading.js';

/**
 * RFC 5322 / MIME composition.
 *
 * The governing rule: **the output must be indistinguishable from a message the
 * user's own mail client would produce.** No `X-Mailer`, no `X-Originating-*`,
 * no custom `X-` header, no footer, no tracking pixel. A test asserts the header
 * set against an allowlist, so adding a branding header fails CI rather than
 * quietly fingerprinting every user's mail (ADR 0003).
 */

export interface ComposeInput {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: OutboundAttachment[];

  inReplyTo?: string;
  references?: string[];

  date?: Date;
  /** Injected in tests; otherwise randomly generated. */
  messageId?: string;
  boundarySeed?: () => string;
}

export interface ComposedMessage {
  raw: string;
  messageId: string;
}

/**
 * Headers we are permitted to emit. Anything outside this set would be a
 * fingerprint identifying how the message was sent.
 */
export const ALLOWED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'content-id',
]);

const CRLF = '\r\n';

export function composeMime(input: ComposeInput): ComposedMessage {
  if (input.to.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A message needs at least one recipient');
  }

  const date = input.date ?? new Date();
  const messageId = input.messageId ?? generateMessageId(input.from.address, randomToken());
  const newBoundary = input.boundarySeed ?? randomToken;

  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${formatAddressList(input.to)}`,
  ];

  if (input.cc?.length) headers.push(`Cc: ${formatAddressList(input.cc)}`);
  if (input.bcc?.length) headers.push(`Bcc: ${formatAddressList(input.bcc)}`);

  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`);
  headers.push(`Date: ${formatRfc2822Date(date)}`);
  headers.push(`Message-ID: ${messageId}`);

  // Threading. Emitted together or not at all — a reply carrying In-Reply-To
  // without References detaches in several clients.
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references?.length) {
    headers.push(foldHeader('References', input.references.join(' ')));
  }

  headers.push('MIME-Version: 1.0');

  const hasAttachments = (input.attachments?.length ?? 0) > 0;
  const hasHtml = Boolean(input.bodyHtml);

  let body: string;

  if (hasAttachments) {
    const mixed = `mixed_${newBoundary()}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);

    const parts = [
      hasHtml
        ? buildAlternative(input.bodyText, input.bodyHtml!, `alt_${newBoundary()}`)
        : buildTextPart(input.bodyText),
      ...(input.attachments ?? []).map(buildAttachmentPart),
    ];

    body = wrapMultipart(mixed, parts);
  } else if (hasHtml) {
    const alt = `alt_${newBoundary()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    body = wrapMultipart(alt, [buildTextPart(input.bodyText), buildHtmlPart(input.bodyHtml!)]);
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push('Content-Transfer-Encoding: base64');
    body = chunk(Buffer.from(input.bodyText, 'utf8').toString('base64'));
  }

  return { raw: `${headers.join(CRLF)}${CRLF}${CRLF}${body}`, messageId };
}

function buildAlternative(text: string, html: string, boundary: string): string {
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    wrapMultipart(boundary, [buildTextPart(text), buildHtmlPart(html)]),
  ].join(CRLF);
}

function buildTextPart(text: string): string {
  return [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    chunk(Buffer.from(text, 'utf8').toString('base64')),
  ].join(CRLF);
}

function buildHtmlPart(html: string): string {
  return [
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    chunk(Buffer.from(html, 'utf8').toString('base64')),
  ].join(CRLF);
}

function buildAttachmentPart(attachment: OutboundAttachment): string {
  const filename = encodeFilename(attachment.filename);
  return [
    `Content-Type: ${normalizeMimeType(attachment.mimeType)}; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    ...(attachment.contentId ? [`Content-ID: <${sanitizeToken(attachment.contentId)}>`] : []),
    '',
    chunk(attachment.content.toString('base64')),
  ].join(CRLF);
}

function wrapMultipart(boundary: string, parts: string[]): string {
  return [...parts.map((part) => `--${boundary}${CRLF}${part}`), `--${boundary}--`, ''].join(CRLF);
}

/* --------------------------------- encoding -------------------------------- */

/**
 * Formats an address, quoting the display name when it contains a character
 * that would otherwise break the header.
 */
export function formatAddress(address: EmailAddress): string {
  const email = address.address.trim();
  assertNoHeaderInjection(email);

  if (!address.name) return email;

  const name = address.name.trim();
  assertNoHeaderInjection(name);

  if (/^[\w .'-]+$/.test(name)) {
    // Simple ASCII names still need quoting when they contain a period, which
    // is a special character in the address grammar.
    return /[.]/.test(name) ? `"${name}" <${email}>` : `${name} <${email}>`;
  }

  return `${encodeHeaderValue(name)} <${email}>`;
}

export function formatAddressList(addresses: EmailAddress[]): string {
  return addresses.map(formatAddress).join(', ');
}

/**
 * RFC 2047 encoded-word for non-ASCII header values.
 *
 * Without this, a subject containing "café" or "习" arrives as mojibake — which
 * is precisely the kind of tell this system must not produce.
 */
export function encodeHeaderValue(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(cleaned)) return cleaned;

  // Split into chunks that stay under the 75-character encoded-word limit,
  // splitting on character boundaries so multibyte sequences stay intact.
  const chunks: string[] = [];
  let current = '';
  for (const char of cleaned) {
    const candidate = current + char;
    if (Buffer.from(candidate, 'utf8').toString('base64').length > 45) {
      chunks.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks
    .map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`)
    .join(`${CRLF} `);
}

/** Folds a long header across continuation lines at whitespace. */
function foldHeader(name: string, value: string): string {
  const prefix = `${name}: `;
  if (prefix.length + value.length <= 78) return prefix + value;

  const parts = value.split(' ');
  const lines: string[] = [];
  let line = prefix;

  for (const part of parts) {
    if (line.length + part.length + 1 > 78 && line.trim() !== prefix.trim()) {
      lines.push(line);
      line = ` ${part}`;
    } else {
      line = line.trim() === '' ? part : `${line}${line.endsWith(' ') ? '' : ' '}${part}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * Rejects CR/LF in any value that reaches a header.
 *
 * Header injection is how an attacker turns a display name into a `Bcc:` — the
 * classic email injection. Since a display name here can originate from an AI
 * draft or a user's WhatsApp message, this is not theoretical.
 */
function assertNoHeaderInjection(value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new AppError('VALIDATION_FAILED', 'Header value contains a line break', {
      publicMessage: 'That name or address is not valid.',
    });
  }
}

/**
 * MIME types are *validated*, not sanitized.
 *
 * Stripping the dangerous characters out of `text/plain";\r\nX-Evil: 1` leaves
 * `text/plainX-Evil: 1` — no longer an injection, but a malformed `Content-Type`
 * that a receiving parser may interpret in ways we did not intend. A type either
 * matches RFC 2045's grammar or it does not, and anything that does not is
 * treated as unknown binary.
 */
const MIME_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

function normalizeMimeType(value: string): string {
  const trimmed = value.trim();
  return MIME_TYPE_RE.test(trimmed) ? trimmed : 'application/octet-stream';
}

/**
 * Filenames drop every character with meaning inside a header parameter.
 *
 * Quotes and backslashes could break out of the quoted string; `;` and `:` could
 * make the remainder look like another parameter or field to a lenient parser.
 * None of them are common in real filenames, so removing them costs nothing.
 */
function encodeFilename(filename: string): string {
  const cleaned = filename.replace(/[\r\n\t\0"\\;:]/g, '').trim() || 'attachment';
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(cleaned) ? encodeHeaderValue(cleaned) : cleaned;
}

function sanitizeToken(value: string): string {
  return value.replace(/[\r\n"\\;]/g, '');
}

/** Base64 bodies must be wrapped at 76 characters per RFC 2045. */
function chunk(base64: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += width) {
    lines.push(base64.slice(i, i + width));
  }
  return lines.join(CRLF);
}

function randomToken(): string {
  return randomBytes(12).toString('hex');
}

/**
 * Gmail's `users.messages.send` takes base64url-encoded RFC 5322, unpadded.
 */
export function toGmailRaw(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * The quoted original, in the convention every mail client uses.
 *
 * Matching the convention matters: a reply whose quoting looks unusual is the
 * kind of small tell that makes a recipient look twice.
 */
export function quoteOriginal(
  original: { from: EmailAddress; sentAt: Date; bodyText: string },
  locale = 'en-GB',
): string {
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(original.sentAt);

  const who = original.from.name
    ? `${original.from.name} <${original.from.address}>`
    : original.from.address;

  const quoted = original.bodyText
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  return `On ${when}, ${who} wrote:\n${quoted}`;
}

export function quoteOriginalHtml(
  original: { from: EmailAddress; sentAt: Date; bodyHtml?: string; bodyText: string },
  locale = 'en-GB',
): string {
  const when = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(original.sentAt);

  const who = escapeHtml(
    original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address,
  );

  const inner = original.bodyHtml ?? `<pre>${escapeHtml(original.bodyText)}</pre>`;

  return (
    `<div>On ${escapeHtml(when)}, ${who} wrote:</div>` +
    `<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">` +
    `${inner}</blockquote>`
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** RFC 2822 date, e.g. `Tue, 04 Aug 2026 14:30:00 +0000`. */
export function formatRfc2822Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/**
 * Extracts the header block's field names, for the CI assertion that we emit
 * nothing outside the allowlist.
 */
export function extractHeaderNames(raw: string): string[] {
  const headerBlock = raw.split(`${CRLF}${CRLF}`)[0] ?? '';
  return headerBlock
    .split(CRLF)
    .filter((line) => !/^\s/.test(line)) // skip folded continuations
    .map((line) => line.split(':', 1)[0]?.trim().toLowerCase() ?? '')
    .filter(Boolean);
}
