import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Readable } from 'node:stream';
import {
  AppError,
  type ChangeEvent,
  type MailLabel,
  type MailOperation,
  type MailProviderKind,
  type NormalizedMessage,
  type OutboundMessage,
  type SendResult,
  type WatchHandle,
} from '@wea/shared';
import type { MailProvider, ProviderAccount, TokenRefreshCallback } from '../provider.js';
import { normalizeGmailMessage, type GmailMessage } from './gmail-normalize.js';
import { composeMime, toGmailRaw } from '../mime-builder.js';
import { mapGmailError } from './gmail-errors.js';

/**
 * The Gmail adapter.
 *
 * Everything provider-shaped stops here. Callers see only the `MailProvider`
 * port, so nothing downstream knows a mailbox is Gmail — which is what makes
 * adding Outlook a new file rather than a change to the pipeline.
 *
 * The parts that carry real risk are the ones with comments: history sync's
 * expiry handling, and send's threading.
 */
export class GmailProvider implements MailProvider {
  readonly kind: MailProviderKind = 'gmail';

  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      pubsubTopic?: string;
      /** Called when an access token is refreshed, so the caller can persist it. */
      onTokenRefresh?: TokenRefreshCallback;
    },
  ) {}

  private client(account: ProviderAccount): gmail_v1.Gmail {
    const auth = new OAuth2Client({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      redirectUri: this.options.redirectUri,
    });

    auth.setCredentials({
      access_token: account.accessToken,
      ...(account.refreshToken ? { refresh_token: account.refreshToken } : {}),
      ...(account.tokenExpiresAt ? { expiry_date: account.tokenExpiresAt.getTime() } : {}),
    });

    // google-auth-library refreshes transparently. Without this hook the new
    // token lives only in memory, and every worker re-refreshes on every job —
    // which Google eventually rate-limits.
    auth.on('tokens', (tokens) => {
      if (!tokens.access_token || !this.options.onTokenRefresh) return;
      void this.options.onTokenRefresh(account.id, {
        accessToken: tokens.access_token,
        expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3_500_000),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      });
    });

    return google.gmail({ version: 'v1', auth });
  }

  async verifyAccess(
    account: ProviderAccount,
  ): Promise<{ emailAddress: string; providerAccountId: string }> {
    try {
      const { data } = await this.client(account).users.getProfile({ userId: 'me' });
      return {
        emailAddress: data.emailAddress ?? account.emailAddress,
        providerAccountId: data.emailAddress ?? account.emailAddress,
      };
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'verifyAccess' });
    }
  }

  /* --------------------------------- watch --------------------------------- */

  async watch(account: ProviderAccount): Promise<WatchHandle> {
    if (!this.options.pubsubTopic) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'No Pub/Sub topic configured for Gmail push');
    }

    try {
      const { data } = await this.client(account).users.watch({
        userId: 'me',
        requestBody: {
          topicName: this.options.pubsubTopic,
          labelIds: ['INBOX'],
          labelFilterBehavior: 'include',
        },
      });

      return {
        expiresAt: new Date(Number(data.expiration ?? Date.now() + 7 * 86_400_000)),
        cursor: { value: String(data.historyId ?? ''), updatedAt: new Date() },
      };
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'watch' });
    }
  }

  /** Gmail's watch is idempotent — re-issuing it is the renewal. */
  renewWatch(account: ProviderAccount): Promise<WatchHandle> {
    return this.watch(account);
  }

  async stopWatch(account: ProviderAccount): Promise<void> {
    try {
      await this.client(account).users.stop({ userId: 'me' });
    } catch (err) {
      const mapped = mapGmailError(err, { accountId: account.id, op: 'stopWatch' });
      // Already stopped, or the grant is gone — either way the desired state is
      // reached. Failing a disconnect over this would strand the account.
      if (mapped.code === 'NOT_FOUND' || mapped.code === 'PROVIDER_UNAUTHORIZED') return;
      throw mapped;
    }
  }

  async getInitialCursor(account: ProviderAccount): Promise<string> {
    try {
      const { data } = await this.client(account).users.getProfile({ userId: 'me' });
      return String(data.historyId ?? '');
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'getInitialCursor' });
    }
  }

  /* --------------------------------- sync ---------------------------------- */

  /**
   * Yields changes since `cursor`.
   *
   * Async iteration, not an array: a mailbox that was offline overnight can have
   * thousands of changes, and buffering them all before processing any is how a
   * worker runs out of memory.
   *
   * Gmail keeps history for roughly a week. Past that it returns 404/412, which
   * is a *normal* operating condition for a paused account, not an incident — so
   * it surfaces as a distinct error the caller handles with a full resync rather
   * than as a generic failure.
   */
  async *fetchChanges(
    account: ProviderAccount,
    cursor: string | null,
  ): AsyncGenerator<ChangeEvent, string | null> {
    // Nothing to walk from. The caller establishes a starting point with
    // `getInitialCursor` rather than guessing one here.
    if (!cursor) return null;

    const gmail = this.client(account);
    let pageToken: string | undefined;
    let latest: string | null = null;

    do {
      let page: gmail_v1.Schema$ListHistoryResponse;
      try {
        const { data } = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: cursor,
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
          maxResults: 500,
          ...(pageToken ? { pageToken } : {}),
        });
        page = data;
      } catch (err) {
        throw mapGmailError(err, { accountId: account.id, op: 'history.list', historyId: cursor });
      }

      for (const record of page.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          if (!added.message?.id) continue;
          yield {
            type: 'messageAdded',
            providerMessageId: added.message.id,
            ...(added.message.threadId ? { providerThreadId: added.message.threadId } : {}),
            ...(added.message.labelIds ? { labels: added.message.labelIds } : {}),
          };
        }

        for (const deleted of record.messagesDeleted ?? []) {
          if (!deleted.message?.id) continue;
          yield { type: 'messageDeleted', providerMessageId: deleted.message.id };
        }

        for (const change of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
          if (!change.message?.id) continue;
          yield {
            type: 'labelsChanged',
            providerMessageId: change.message.id,
            ...(change.message.labelIds ? { labels: change.message.labelIds } : {}),
          };
        }
      }

      // Gmail reports the mailbox's current position on every page. This — not
      // the id of the last message we happened to see — is what resumes the
      // next sync.
      if (page.historyId) latest = page.historyId;

      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    return latest;
  }

  async getMessage(
    account: ProviderAccount,
    providerMessageId: string,
  ): Promise<NormalizedMessage> {
    try {
      const { data } = await this.client(account).users.messages.get({
        userId: 'me',
        id: providerMessageId,
        format: 'full',
      });
      return normalizeGmailMessage(data as GmailMessage);
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'messages.get' });
    }
  }

  async getAttachment(
    account: ProviderAccount,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Readable> {
    try {
      const { data } = await this.client(account).users.messages.attachments.get({
        userId: 'me',
        messageId: providerMessageId,
        id: providerAttachmentId,
      });

      if (!data.data) {
        throw new AppError('NOT_FOUND', 'Attachment had no content');
      }

      // Gmail returns the whole attachment base64url-encoded in one response —
      // there is no streaming endpoint — so the stream is constructed here to
      // keep the port's contract honest for providers that do stream.
      return Readable.from([Buffer.from(data.data, 'base64url')]);
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'attachments.get' });
    }
  }

  /* --------------------------------- send ---------------------------------- */

  /**
   * Sends a message through the user's own mailbox.
   *
   * Two things make the reply indistinguishable from one typed in Gmail
   * (ADR 0003): it goes out over the user's own OAuth grant, so SPF/DKIM/DMARC
   * align on their domain and the sent copy lands in their own Sent folder; and
   * the MIME carries no header outside the allowlist.
   *
   * `threadId` is passed alongside the headers because Gmail uses it for its own
   * conversation grouping — but the `References` chain is what every *other*
   * client threads on, so both are set.
   */
  async send(account: ProviderAccount, message: OutboundMessage): Promise<SendResult> {
    const composed = composeMime({
      from: { address: account.emailAddress },
      to: message.to,
      ...(message.cc ? { cc: message.cc } : {}),
      ...(message.bcc ? { bcc: message.bcc } : {}),
      subject: message.subject,
      bodyText: message.bodyText,
      ...(message.bodyHtml ? { bodyHtml: message.bodyHtml } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
      ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
      ...(message.references ? { references: message.references } : {}),
    });

    try {
      const { data } = await this.client(account).users.messages.send({
        userId: 'me',
        requestBody: {
          raw: toGmailRaw(composed.raw),
          ...(message.providerThreadId ? { threadId: message.providerThreadId } : {}),
        },
      });

      return {
        providerMessageId: data.id ?? '',
        providerThreadId: data.threadId ?? message.providerThreadId ?? '',
        messageIdHeader: composed.messageId,
        sentAt: new Date(),
      };
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'messages.send' });
    }
  }

  /* -------------------------------- mutate --------------------------------- */

  async mutate(
    account: ProviderAccount,
    providerMessageId: string,
    operation: MailOperation,
  ): Promise<void> {
    const gmail = this.client(account);

    try {
      switch (operation.kind) {
        case 'archive':
          // Gmail has no archive verb — removing INBOX *is* archiving.
          await gmail.users.messages.modify({
            userId: 'me',
            id: providerMessageId,
            requestBody: { removeLabelIds: ['INBOX'] },
          });
          return;

        case 'unarchive':
          // Symmetrical with archive: Gmail has no verb for either, and the
          // INBOX label is what the words mean.
          await gmail.users.messages.modify({
            userId: 'me',
            id: providerMessageId,
            requestBody: { addLabelIds: ['INBOX'] },
          });
          return;

        case 'delete':
          if (operation.permanent) {
            // Irreversible, and not reachable from a WhatsApp command — only
            // from an explicit account-deletion flow.
            await gmail.users.messages.delete({ userId: 'me', id: providerMessageId });
          } else {
            await gmail.users.messages.trash({ userId: 'me', id: providerMessageId });
          }
          return;

        case 'markRead':
          await gmail.users.messages.modify({
            userId: 'me',
            id: providerMessageId,
            requestBody: operation.read
              ? { removeLabelIds: ['UNREAD'] }
              : { addLabelIds: ['UNREAD'] },
          });
          return;

        case 'star':
          await gmail.users.messages.modify({
            userId: 'me',
            id: providerMessageId,
            requestBody: operation.starred
              ? { addLabelIds: ['STARRED'] }
              : { removeLabelIds: ['STARRED'] },
          });
          return;

        case 'spam':
          await gmail.users.messages.modify({
            userId: 'me',
            id: providerMessageId,
            requestBody: operation.isSpam
              ? { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] }
              : { removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] },
          });
          return;

        case 'label':
          await gmail.users.messages.modify({
            userId: 'me',
            id: providerMessageId,
            requestBody: {
              ...(operation.add ? { addLabelIds: operation.add } : {}),
              ...(operation.remove ? { removeLabelIds: operation.remove } : {}),
            },
          });
          return;
      }
    } catch (err) {
      throw mapGmailError(err, {
        accountId: account.id,
        op: `mutate.${operation.kind}`,
      });
    }
  }

  /* --------------------------------- labels -------------------------------- */

  /**
   * The user's own labels.
   *
   * `type: 'system'` is filtered out, and that filter is the whole reason this
   * cannot be a pass-through: Gmail returns INBOX, SENT, SPAM, TRASH, DRAFT and
   * the category tabs alongside the user's own. None of them are things anyone
   * files mail under by name, and adding TRASH to a message on request is
   * deleting it by a route with no confirmation.
   */
  async listLabels(account: ProviderAccount): Promise<MailLabel[]> {
    const gmail = this.client(account);

    try {
      const response = await gmail.users.labels.list({ userId: 'me' });

      return (response.data.labels ?? [])
        .filter((label) => label.type !== 'system' && label.id && label.name)
        .map((label) => ({ id: label.id!, name: label.name! }));
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'labels.list' });
    }
  }

  async createLabel(account: ProviderAccount, name: string): Promise<MailLabel> {
    const gmail = this.client(account);

    try {
      const response = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          // Both default to hidden, which produces a label the user cannot find
          // in their own mailbox — indistinguishable, to them, from us having
          // failed to create it.
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });

      if (!response.data.id) {
        throw new AppError('PROVIDER_ERROR', 'Gmail created a label without returning its id');
      }

      return { id: response.data.id, name: response.data.name ?? name };
    } catch (err) {
      throw mapGmailError(err, { accountId: account.id, op: 'labels.create' });
    }
  }

  /* --------------------------------- oauth --------------------------------- */

  /**
   * The consent URL.
   *
   * `access_type: offline` with `prompt: consent` is what actually returns a
   * refresh token. Without the prompt, a user who has authorised before gets no
   * refresh token back, and the connection silently dies an hour later — a bug
   * that only shows up for returning users.
   */
  authorizationUrl(state: string, scopes: string[]): string {
    const auth = new OAuth2Client({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      redirectUri: this.options.redirectUri,
    });

    return auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: scopes,
      state,
    });
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
    scopes: string[];
  }> {
    const auth = new OAuth2Client({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      redirectUri: this.options.redirectUri,
    });

    try {
      const { tokens } = await auth.getToken(code);

      if (!tokens.access_token) {
        throw new AppError('PROVIDER_ERROR', 'Google returned no access token');
      }
      if (!tokens.refresh_token) {
        // Without one we cannot act on the mailbox beyond the first hour, so
        // this is a hard failure at connect time rather than a mystery later.
        throw new AppError('PROVIDER_ERROR', 'Google returned no refresh token', {
          publicMessage:
            'We could not complete the connection. Please remove our access in your Google account and try again.',
          retryable: false,
        });
      }

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3_500_000),
        scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
      };
    } catch (err) {
      throw mapGmailError(err, { op: 'exchangeCode' });
    }
  }
}

/** The narrowest scopes that support read, send and label mutation. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];
