/**
 * Provider-neutral email domain types.
 *
 * Gmail, Microsoft Graph and IMAP each describe a message differently. Every
 * adapter in `@wea/mail` normalizes into the shapes below, so nothing downstream
 * — ingest, AI, notify, send — ever branches on which provider a mailbox uses.
 */

export type MailProviderKind = 'gmail' | 'outlook' | 'microsoft365' | 'imap';

export interface EmailAddress {
  /** Display name, when the header carried one. */
  name?: string;
  /** Normalized to lower case. */
  address: string;
}

export type AttachmentDisposition = 'attachment' | 'inline';

export interface EmailAttachment {
  /** Provider-scoped attachment identifier, used to fetch the bytes on demand. */
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  disposition: AttachmentDisposition;
  /** Present for inline images referenced by `cid:` in the HTML body. */
  contentId?: string;
  /** Set once the bytes have been streamed to object storage. */
  storageKey?: string;
}

/**
 * A message after normalization. `headers` keeps only what threading, display
 * and abuse-detection need — we deliberately do not retain the full header set.
 */
export interface NormalizedMessage {
  providerMessageId: string;
  providerThreadId: string;
  /** RFC 5322 `Message-ID`, angle brackets included. The threading anchor. */
  messageIdHeader: string;
  inReplyTo?: string;
  /** Oldest ancestor first, as it appears on the wire. */
  references: string[];

  subject: string;
  from: EmailAddress;
  replyTo?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];

  /** When the sender's client claims it was sent. */
  sentAt: Date;
  /** When it landed in the mailbox — what we show the user. */
  receivedAt: Date;

  /** Plain-text body, derived from text/plain or downgraded from HTML. */
  bodyText: string;
  /** Raw HTML body if present. NEVER render this without sanitizing first. */
  bodyHtml?: string;
  /** First ~200 characters of plain text, for compact previews. */
  snippet: string;

  attachments: EmailAttachment[];

  isUnread: boolean;
  isStarred: boolean;
  isDraft: boolean;
  /** Provider folder/label names, passed through unmodified. */
  labels: string[];
  sizeBytes: number;
  /** Present when the provider or our own detection identified a language. */
  detectedLanguage?: string;
}

/** An outbound message, before it is serialized to MIME. */
export interface OutboundMessage {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: OutboundAttachment[];

  /**
   * Threading. Set together or not at all — a reply missing `references`
   * detaches into a new conversation in most clients (ADR 0003).
   */
  inReplyTo?: string;
  references?: string[];
  /** Provider thread handle, when the provider wants one on send. */
  providerThreadId?: string;

  /**
   * Idempotency key. The send queue guarantees at-most-once delivery per key;
   * a retried job with the same key is a no-op rather than a duplicate email.
   */
  idempotencyKey: string;
}

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
  contentId?: string;
}

export interface SendResult {
  providerMessageId: string;
  providerThreadId: string;
  /** The `Message-ID` the provider assigned, so we can thread future replies. */
  messageIdHeader: string;
  sentAt: Date;
}

/** Mailbox mutations, expressed provider-neutrally. */
export type MailOperation =
  | { kind: 'archive' }
  | { kind: 'delete'; permanent: boolean }
  | { kind: 'markRead'; read: boolean }
  | { kind: 'star'; starred: boolean }
  | { kind: 'label'; add?: string[]; remove?: string[] }
  | { kind: 'spam'; isSpam: boolean };

/**
 * A filing name in the user's mailbox, with whatever `mutate` needs to apply it.
 *
 * `id` and `name` are the same string for Outlook, whose categories have no ids,
 * and differ for Gmail, whose `addLabelIds` rejects names. Callers pass `id` and
 * show `name`; nothing above the adapter needs to know which mailbox it is.
 */
export interface MailLabel {
  id: string;
  name: string;
}

/** One change reported by a provider's push or delta channel. */
export interface ChangeEvent {
  type: 'messageAdded' | 'messageDeleted' | 'labelsChanged';
  providerMessageId: string;
  providerThreadId?: string;
  labels?: string[];
}

/** Opaque per-provider sync position (Gmail historyId, Graph deltaLink, IMAP UID). */
export interface SyncCursor {
  value: string;
  updatedAt: Date;
}

export interface WatchHandle {
  /** Provider-issued subscription identifier, needed to renew or cancel. */
  subscriptionId?: string;
  expiresAt: Date;
  cursor: SyncCursor;
}

export type EmailCategory =
  | 'primary'
  | 'work'
  | 'personal'
  | 'finance'
  | 'invoice'
  | 'travel'
  | 'shopping'
  | 'social'
  | 'newsletter'
  | 'promotion'
  | 'notification'
  | 'support'
  | 'recruitment'
  | 'legal'
  | 'spam'
  | 'other';

export type EmailPriority = 'urgent' | 'high' | 'normal' | 'low';
