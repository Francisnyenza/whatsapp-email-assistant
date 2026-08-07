import type {
  ChangeEvent,
  MailOperation,
  MailProviderKind,
  NormalizedMessage,
  OutboundMessage,
  SendResult,
  WatchHandle,
} from '@wea/shared';
import type { Readable } from 'node:stream';

/**
 * The port every mailbox implementation satisfies.
 *
 * Gmail, Microsoft Graph and IMAP describe a mailbox in three incompatible
 * ways. Everything above this interface — ingest, AI, notify, send — is written
 * against these methods alone, so adding IMAP is a new file rather than a change
 * to the pipeline.
 *
 * Two rules for implementors:
 *
 *  1. **Normalize completely.** Nothing provider-shaped may leak through. A
 *     caller must never need to know whether a mailbox is Gmail.
 *  2. **Throw AppError, not provider errors.** In particular, map an expired
 *     grant to PROVIDER_UNAUTHORIZED and a quota rejection to
 *     PROVIDER_RATE_LIMITED, because the queue's retry behaviour depends on that
 *     distinction.
 */
export interface MailProvider {
  readonly kind: MailProviderKind;

  /**
   * Registers for push notifications.
   *
   * Every provider expires these — Gmail after 7 days, Graph after about 3 — so
   * the caller schedules renewal from `expiresAt`. An implementation that cannot
   * do push returns a handle with a far-future expiry and relies on polling.
   */
  watch(account: ProviderAccount): Promise<WatchHandle>;
  renewWatch(account: ProviderAccount): Promise<WatchHandle>;
  stopWatch(account: ProviderAccount): Promise<void>;

  /**
   * Yields changes since `cursor`.
   *
   * Async iteration rather than an array: a mailbox that has been offline for a
   * day can have thousands of changes, and buffering them all before processing
   * any is how a worker runs out of memory.
   */
  /**
   * Walks changes since `cursor`.
   *
   * Returns the provider's own new cursor as the generator's return value, not
   * as a yielded event — the caller must store *that* and nothing else. Deriving
   * a cursor from the last change seen is the bug this signature exists to
   * prevent: a Gmail message id is not a historyId, and storing one produces a
   * mailbox that never syncs again.
   */
  fetchChanges(
    account: ProviderAccount,
    cursor: string | null,
  ): AsyncGenerator<ChangeEvent, string | null>;

  /** The cursor to resume from, for an account with no sync history. */
  getInitialCursor(account: ProviderAccount): Promise<string>;

  getMessage(account: ProviderAccount, providerMessageId: string): Promise<NormalizedMessage>;

  /** Streamed, never buffered: attachments reach 25 MB and beyond. */
  getAttachment(
    account: ProviderAccount,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Readable>;

  send(account: ProviderAccount, message: OutboundMessage): Promise<SendResult>;

  mutate(
    account: ProviderAccount,
    providerMessageId: string,
    operation: MailOperation,
  ): Promise<void>;

  /** Confirms the grant still works, for the health check and reconnect flow. */
  verifyAccess(
    account: ProviderAccount,
  ): Promise<{ emailAddress: string; providerAccountId: string }>;
}

/**
 * What an adapter needs to act on a mailbox.
 *
 * Tokens arrive already decrypted — the adapter never touches the database or
 * the KMS, which keeps it testable and keeps decryption in one place.
 */
export interface ProviderAccount {
  id: string;
  userId: string;
  emailAddress: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  /**
   * Where this mailbox was last synced to. The adapter's own opaque value —
   * Gmail's historyId, Graph's deltaLink — and the only correct place to resume
   * from.
   */
  syncCursor?: string | null;
  /** Provider-specific settings: Gmail's Pub/Sub topic, Graph's notification URL. */
  config?: Record<string, string>;
}

/**
 * Called when an adapter refreshes an expired access token, so the caller can
 * re-encrypt and persist it. Returning a token from `send` instead would mean
 * every call site had to remember to persist it.
 */
export type TokenRefreshCallback = (
  accountId: string,
  tokens: { accessToken: string; expiresAt: Date; refreshToken?: string },
) => Promise<void>;
