import type { EmailAddress, EmailAttachment, NormalizedMessage } from '@wea/shared';
import { normalizeMessageId, parseReferences } from '../threading.js';
import { htmlToText } from './gmail-normalize.js';

/**
 * Turning a Microsoft Graph message into our normalized shape.
 *
 * Much less work than the Gmail equivalent, because Graph has already parsed the
 * MIME: addresses arrive structured, the body arrives decoded, attachments
 * arrive as a list. What it costs instead is a set of small traps, and every one
 * of them is a silent wrong answer rather than an error:
 *
 *  - **`internetMessageHeaders` is not returned unless you ask for it**, and it
 *    is the only place `In-Reply-To` and `References` live. Forget the
 *    `$select` and threading appears to work — replies just quietly start new
 *    conversations in the recipient's client (ADR 0003).
 *  - **`conversationId` is not a thread id in the RFC sense.** Outlook groups by
 *    normalized subject as well as by reference chain, so two unrelated emails
 *    with the same subject share one. It is still the right value to store,
 *    because it is what Outlook itself threads on — but the reference chain is
 *    what we resolve replies with.
 *  - **`body.content` is HTML far more often than with Gmail**, because Outlook
 *    composes HTML by default. A normalizer that trusted `contentType` to be
 *    `text` would produce summaries full of markup.
 */

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphAttachment {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string;
  '@odata.type'?: string;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string | null;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphRecipient;
  sender?: GraphRecipient;
  replyTo?: GraphRecipient[];
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  sentDateTime?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  parentFolderId?: string;
  hasAttachments?: boolean;
  attachments?: GraphAttachment[];
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
}

/**
 * The fields a normalized message needs, as a `$select`.
 *
 * Kept next to the normalizer rather than in the client, because the two must
 * agree and this is the file where forgetting one is visible. `$select` is not
 * an optimisation here: Graph omits `internetMessageHeaders` entirely unless it
 * is named, so this list is load-bearing.
 */
export const GRAPH_MESSAGE_SELECT = [
  'id',
  'conversationId',
  'internetMessageId',
  'internetMessageHeaders',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'replyTo',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'sentDateTime',
  'receivedDateTime',
  'isRead',
  'isDraft',
  'flag',
  'categories',
  'parentFolderId',
  'hasAttachments',
].join(',');

/** Header lookup is case-insensitive: Graph preserves the sender's casing. */
export function findGraphHeader(message: GraphMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return message.internetMessageHeaders?.find((h) => h.name?.toLowerCase() === lower)?.value;
}

export function toEmailAddress(recipient: GraphRecipient | undefined): EmailAddress | null {
  const address = recipient?.emailAddress?.address?.trim().toLowerCase();
  if (!address) return null;

  const name = recipient?.emailAddress?.name?.trim();
  // Outlook fills `name` with the address when there is no display name, which
  // renders as "sarah@acme.com <sarah@acme.com>" on a notification card.
  return name && name.toLowerCase() !== address ? { name, address } : { address };
}

function toAddressList(recipients: GraphRecipient[] | undefined): EmailAddress[] {
  return (recipients ?? []).map(toEmailAddress).filter((a): a is EmailAddress => a !== null);
}

export function normalizeGraphMessage(message: GraphMessage): NormalizedMessage {
  const isHtml = (message.body?.contentType ?? '').toLowerCase() === 'html';
  const rawBody = message.body?.content ?? '';

  const bodyText = isHtml ? htmlToText(rawBody) : rawBody;
  const bodyHtml = isHtml ? rawBody : undefined;

  const references = parseReferences(findGraphHeader(message, 'References'));
  const inReplyTo = normalizeMessageId(findGraphHeader(message, 'In-Reply-To'));

  const from = toEmailAddress(message.from) ??
    toEmailAddress(message.sender) ?? { address: 'unknown@invalid' };

  const replyTo = toAddressList(message.replyTo)[0];

  // Graph's `bodyPreview` is already the first ~255 characters, but it is not
  // always present on a delta payload — so it is a preference, not a source.
  const snippet = (message.bodyPreview?.trim() || bodyText).slice(0, 200);

  const sentAt = parseDate(message.sentDateTime);
  const receivedAt = parseDate(message.receivedDateTime) ?? sentAt ?? new Date();

  return {
    providerMessageId: message.id,
    providerThreadId: message.conversationId ?? message.id,
    messageIdHeader: normalizeMessageId(message.internetMessageId) ?? '',
    ...(inReplyTo ? { inReplyTo } : {}),
    references,

    subject: message.subject?.trim() ?? '',
    from,
    ...(replyTo ? { replyTo } : {}),
    to: toAddressList(message.toRecipients),
    cc: toAddressList(message.ccRecipients),
    bcc: toAddressList(message.bccRecipients),

    sentAt: sentAt ?? receivedAt,
    receivedAt,

    bodyText,
    ...(bodyHtml ? { bodyHtml } : {}),
    snippet,

    attachments: normalizeAttachments(message.attachments),

    isUnread: message.isRead === false,
    // Outlook has no star. Its flag is the same gesture — "come back to this" —
    // and mapping it keeps one concept in the product instead of two.
    isStarred: message.flag?.flagStatus === 'flagged',
    isDraft: message.isDraft === true,
    // Categories are Outlook's labels. The folder is not included: it is an id
    // rather than a name, and a caller that wanted "Archive" would get a
    // base64 blob.
    labels: message.categories ?? [],
    sizeBytes: estimateSize(message),
  };
}

function normalizeAttachments(attachments: GraphAttachment[] | undefined): EmailAttachment[] {
  return (attachments ?? [])
    .filter((a) => {
      // `itemAttachment` is an embedded Outlook item — a contact, an event,
      // another message — not a file. It has no bytes to stream, so passing it
      // through would produce a download that always fails.
      const type = a['@odata.type'] ?? '';
      return !type.includes('itemAttachment') && !type.includes('referenceAttachment');
    })
    .map((a) => ({
      providerAttachmentId: a.id ?? '',
      filename: a.name ?? 'attachment',
      mimeType: a.contentType ?? 'application/octet-stream',
      sizeBytes: a.size ?? 0,
      disposition: a.isInline ? ('inline' as const) : ('attachment' as const),
      ...(a.contentId ? { contentId: a.contentId } : {}),
    }))
    .filter((a) => a.providerAttachmentId !== '');
}

/**
 * Graph does not report a message size on the message resource, so this is the
 * body plus the attachments — close enough for the quota display it feeds, and
 * honest about being an estimate rather than silently reporting zero.
 */
function estimateSize(message: GraphMessage): number {
  const body = Buffer.byteLength(message.body?.content ?? '', 'utf8');
  const attachments = (message.attachments ?? []).reduce((sum, a) => sum + (a.size ?? 0), 0);
  return body + attachments;
}

/** An unparseable date is null, not an Invalid Date that compares false forever. */
function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
