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
import {
  normalizeGraphMessage,
  GRAPH_MESSAGE_SELECT,
  type GraphMessage,
} from './graph-normalize.js';
import { composeMime } from '../mime-builder.js';
import { mapGraphError } from './graph-errors.js';

/**
 * The Microsoft Graph adapter.
 *
 * Same port as Gmail, and nothing above it knows the difference — which was the
 * point of the port. What is worth reading here is where Graph is *not* like
 * Gmail, because each difference is somewhere the obvious code is quietly wrong:
 *
 *  - **Renewal is a PATCH, not a re-create.** Gmail's `watch` is idempotent, so
 *    renewing is re-issuing. Graph's `POST /subscriptions` creates a *second*
 *    subscription, so a renewal written that way delivers every notification
 *    twice and leaks a subscription every three days.
 *  - **The cursor is a URL, not a number.** Graph's delta link carries an opaque
 *    token inside a full URL, so it is followed rather than parsed — and the
 *    thing that must be stored is the `@odata.deltaLink` from the *last* page,
 *    never a `@odata.nextLink`, which is a paging position and expires in
 *    minutes.
 *  - **Graph assigns its own Message-ID.** Gmail preserves the one in the MIME
 *    we upload; Graph replaces it. Storing ours would mean a reply to our reply
 *    never resolves back to the thread, so the assigned one is read back from
 *    the draft before sending.
 *  - **A subscription needs a reachable notification URL at creation time.**
 *    Graph POSTs a validation token to it and expects the echo within ten
 *    seconds, so `watch` fails in local development unless the webhook is
 *    tunnelled. That is a deployment fact, not a bug.
 */
export class GraphProvider implements MailProvider {
  readonly kind: MailProviderKind = 'outlook';

  private readonly baseUrl: string;
  private readonly authority: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Access tokens, cached until shortly before they expire.
   *
   * Keyed by account rather than global: two mailboxes are two grants. Without
   * this every call refreshes, which Microsoft throttles hard enough to look
   * like an outage.
   */
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly options: {
      clientId: string;
      clientSecret: string;
      redirectUri: string;
      /** `common` for any account, or a directory id to restrict to one tenant. */
      tenantId?: string;
      /** Where Graph should POST change notifications. */
      notificationUrl?: string;
      /** Echoed on every notification; compared constant-time by the webhook. */
      clientState?: string;
      baseUrl?: string;
      authority?: string;
      fetchImpl?: typeof fetch;
      onTokenRefresh?: TokenRefreshCallback;
    },
  ) {
    this.baseUrl = (options.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
    this.authority = (options.authority ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /* --------------------------------- auth ---------------------------------- */

  /**
   * A usable access token for this mailbox.
   *
   * Refreshes a minute early rather than on expiry: a token that expires
   * mid-request produces a 401 that looks exactly like a revoked grant, and
   * telling a user to reconnect a mailbox that was working is worse than a
   * slightly early refresh.
   */
  private async accessToken(account: ProviderAccount): Promise<string> {
    const cached = this.tokens.get(account.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

    const expiresAt = account.tokenExpiresAt?.getTime() ?? 0;
    if (expiresAt > Date.now() + 60_000) {
      this.tokens.set(account.id, { value: account.accessToken, expiresAt });
      return account.accessToken;
    }

    if (!account.refreshToken) {
      // Nothing to refresh with. Not a transient failure — the connection needs
      // re-establishing, and saying so beats retrying into a 401 four times.
      throw new AppError('PROVIDER_UNAUTHORIZED', 'No refresh token for this mailbox', {
        context: { accountId: account.id },
        retryable: false,
        publicMessage: 'We lost access to your mailbox. Please reconnect it.',
      });
    }

    const refreshed = await this.refresh(account.refreshToken, account.id);

    this.tokens.set(account.id, {
      value: refreshed.accessToken,
      expiresAt: refreshed.expiresAt.getTime(),
    });

    // Persisted by the caller, which owns encryption. Without this the new token
    // lives only in this process and every worker refreshes on every job.
    await this.options.onTokenRefresh?.(account.id, refreshed);

    return refreshed.accessToken;
  }

  private async refresh(
    refreshToken: string,
    accountId?: string,
  ): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }> {
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_SCOPES.join(' '),
    });

    const token = await this.token(body, { accountId, op: 'refresh' });

    return {
      accessToken: token.access_token,
      expiresAt: new Date(Date.now() + (token.expires_in ?? 3_600) * 1_000),
      // Microsoft rotates refresh tokens. Dropping the new one leaves us with a
      // token that will stop working at an unpredictable point in the future.
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    };
  }

  private async token(
    body: URLSearchParams,
    context: Record<string, unknown>,
  ): Promise<TokenResponse> {
    const tenant = this.options.tenantId ?? 'common';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.authority}/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      throw new AppError('PROVIDER_ERROR', 'Could not reach Microsoft identity', {
        context,
        retryable: true,
        cause: err,
      });
    }

    const parsed = (await response.json().catch(() => ({}))) as TokenResponse & {
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !parsed.access_token) {
      // `invalid_grant` is the one that matters: consent revoked, password
      // changed, or the token simply aged out. None of those is retryable.
      const revoked = parsed.error === 'invalid_grant' || response.status === 400;
      throw new AppError(
        revoked ? 'PROVIDER_UNAUTHORIZED' : 'PROVIDER_ERROR',
        parsed.error_description ?? parsed.error ?? 'Token request failed',
        {
          context: { ...context, status: response.status, error: parsed.error },
          retryable: !revoked,
          ...(revoked
            ? { publicMessage: 'We lost access to your mailbox. Please reconnect it.' }
            : {}),
        },
      );
    }

    return parsed;
  }

  /* ------------------------------- requests -------------------------------- */

  /**
   * One Graph request.
   *
   * Every error path in this class funnels through here, so the mapping between
   * Graph's failures and ours lives in exactly one place — and `Retry-After` is
   * read off the response rather than guessed, because Graph's throttling
   * windows are minutes long and a fixed backoff either wastes them or ignores
   * them.
   */
  private async request<T>(
    account: ProviderAccount,
    path: string,
    init: RequestInit & { op: string; absoluteUrl?: string },
  ): Promise<T> {
    const token = await this.accessToken(account);
    const url = init.absoluteUrl ?? `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      throw new AppError('PROVIDER_ERROR', 'Could not reach Microsoft Graph', {
        context: { accountId: account.id, op: init.op },
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      const retryAfter = Number(response.headers?.get?.('retry-after') ?? '');

      throw mapGraphError(
        {
          status: response.status,
          code: body.error?.code,
          message: body.error?.message,
          ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
        },
        { accountId: account.id, op: init.op },
      );
    }

    // 202 and 204 carry no body. Parsing them would throw on empty input, which
    // would turn a successful send into a failure.
    if (response.status === 204 || response.status === 202) return undefined as T;

    return (await response.json()) as T;
  }

  async verifyAccess(
    account: ProviderAccount,
  ): Promise<{ emailAddress: string; providerAccountId: string }> {
    const me = await this.request<{ id?: string; mail?: string; userPrincipalName?: string }>(
      account,
      '/me?$select=id,mail,userPrincipalName',
      { method: 'GET', op: 'verifyAccess' },
    );

    // `mail` is null for accounts with no Exchange licence; `userPrincipalName`
    // is always present and is the address in practice.
    const emailAddress = me.mail ?? me.userPrincipalName ?? account.emailAddress;

    return {
      emailAddress: emailAddress.toLowerCase(),
      // The directory object id, not the address. An address can change; this
      // cannot, and it is what identifies the mailbox on reconnect.
      providerAccountId: me.id ?? emailAddress.toLowerCase(),
    };
  }

  /* --------------------------------- watch --------------------------------- */

  /**
   * Subscribes to inbox changes.
   *
   * Graph validates the notification URL synchronously during this call: it
   * POSTs a `validationToken` and expects it echoed back as plain text within
   * ten seconds. So this fails in local development unless the webhook endpoint
   * is publicly reachable — an ordinary deployment constraint, and a confusing
   * one to hit without knowing it.
   */
  async watch(account: ProviderAccount): Promise<WatchHandle> {
    if (!this.options.notificationUrl) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'No notification URL configured for Graph push');
    }

    const created = await this.request<GraphSubscription>(account, '/subscriptions', {
      method: 'POST',
      op: 'subscriptions.create',
      body: JSON.stringify({
        changeType: 'created,updated',
        notificationUrl: this.options.notificationUrl,
        resource: "/me/mailFolders('inbox')/messages",
        expirationDateTime: subscriptionExpiry().toISOString(),
        ...(this.options.clientState ? { clientState: this.options.clientState } : {}),
      }),
    });

    // A subscription tells us *that* something changed, never what — so the
    // cursor has to come from the delta channel independently.
    const cursor = await this.getInitialCursor(account);

    return {
      ...(created.id ? { subscriptionId: created.id } : {}),
      expiresAt: created.expirationDateTime
        ? new Date(created.expirationDateTime)
        : subscriptionExpiry(),
      cursor: { value: cursor, updatedAt: new Date() },
    };
  }

  /**
   * Extends the existing subscription.
   *
   * A PATCH, not another POST. Gmail's watch is idempotent so renewal is
   * re-issuing it; doing that here would create a *second* subscription —
   * every notification delivered twice, and one more subscription leaked every
   * three days until the per-mailbox limit rejects the next one.
   *
   * If the subscription has already lapsed Graph answers 404, and then creating
   * one is exactly right — so that is the only case that falls back.
   */
  async renewWatch(account: ProviderAccount): Promise<WatchHandle> {
    const subscriptionId = account.config?.['subscriptionId'];
    if (!subscriptionId) return this.watch(account);

    try {
      const renewed = await this.request<GraphSubscription>(
        account,
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {
          method: 'PATCH',
          op: 'subscriptions.renew',
          body: JSON.stringify({ expirationDateTime: subscriptionExpiry().toISOString() }),
        },
      );

      return {
        subscriptionId,
        expiresAt: renewed.expirationDateTime
          ? new Date(renewed.expirationDateTime)
          : subscriptionExpiry(),
        // Deliberately not re-read. Renewal must never move the sync position:
        // taking a fresh delta link here would skip every message that arrived
        // between the last sync and this renewal — mail lost by the very job
        // that exists to keep mail flowing.
        cursor: { value: account.syncCursor ?? '', updatedAt: new Date() },
      };
    } catch (err) {
      if (AppError.isAppError(err) && err.code === 'NOT_FOUND') return this.watch(account);
      throw err;
    }
  }

  async stopWatch(account: ProviderAccount): Promise<void> {
    const subscriptionId = account.config?.['subscriptionId'];
    if (!subscriptionId) return;

    try {
      await this.request<void>(account, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'DELETE',
        op: 'subscriptions.delete',
      });
    } catch (err) {
      const mapped = mapGraphError(err, { accountId: account.id, op: 'stopWatch' });
      // Already gone, or the grant is. Either way the desired state is reached,
      // and failing a disconnect over it would strand the account.
      if (mapped.code === 'NOT_FOUND' || mapped.code === 'PROVIDER_UNAUTHORIZED') return;
      throw mapped;
    }
  }

  /* --------------------------------- sync ---------------------------------- */

  /**
   * The delta link to resume from, for a mailbox with no sync history.
   *
   * Graph has no "current position" endpoint. The way to get one is to run a
   * delta query and follow it to the end, which for an established mailbox means
   * paging through the whole inbox — so `$select=id` keeps the payload to
   * identifiers rather than downloading every message twice.
   */
  async getInitialCursor(account: ProviderAccount): Promise<string> {
    let url: string | undefined = `${this.baseUrl}${DELTA_PATH}?$select=id`;
    let deltaLink: string | null = null;

    while (url) {
      const page: GraphDeltaPage = await this.request<GraphDeltaPage>(account, '', {
        method: 'GET',
        op: 'delta.initial',
        absoluteUrl: url,
      });

      deltaLink = page['@odata.deltaLink'] ?? null;
      url = page['@odata.nextLink'];
    }

    if (!deltaLink) {
      throw new AppError('PROVIDER_ERROR', 'Graph delta query returned no delta link', {
        context: { accountId: account.id },
        retryable: true,
      });
    }

    return deltaLink;
  }

  /**
   * Walks changes since `cursor`.
   *
   * The cursor is a full URL, so it is followed rather than parsed. Two things
   * about that are easy to get wrong and both are silent:
   *
   * The value stored afterwards must be the `@odata.deltaLink` from the final
   * page — never a `@odata.nextLink`, which is a paging position that expires in
   * minutes and resumes mid-walk. Returning it as the generator's *return*
   * value rather than yielding it is what makes that hard to confuse.
   *
   * And a delta page reports deletions as an ordinary entry carrying
   * `@removed`, not as an absence. Filtering on `@removed` is what tells a
   * deleted message apart from a changed one; without it every deletion looks
   * like an update to a message that no longer exists.
   */
  async *fetchChanges(
    account: ProviderAccount,
    cursor: string | null,
  ): AsyncGenerator<ChangeEvent, string | null> {
    // Nothing to walk from. The caller establishes a starting point with
    // `getInitialCursor` rather than guessing one here.
    if (!cursor) return null;

    let url: string | undefined = cursor;
    let deltaLink: string | null = null;

    while (url) {
      const page: GraphDeltaPage = await this.request<GraphDeltaPage>(account, '', {
        method: 'GET',
        op: 'delta.list',
        absoluteUrl: url,
      });

      for (const entry of page.value ?? []) {
        if (!entry.id) continue;

        if (entry['@removed']) {
          yield { type: 'messageDeleted', providerMessageId: entry.id };
          continue;
        }

        // Graph does not distinguish "arrived" from "changed" in a delta feed:
        // both are just the resource in its current state. Treating everything
        // as `messageAdded` is correct because ingest is idempotent on
        // `(accountId, providerMessageId)` — a message that was already stored
        // is recognised and only its flags are updated.
        yield {
          type: 'messageAdded',
          providerMessageId: entry.id,
          ...(entry.conversationId ? { providerThreadId: entry.conversationId } : {}),
          ...(entry.categories ? { labels: entry.categories } : {}),
        };
      }

      deltaLink = page['@odata.deltaLink'] ?? deltaLink;
      url = page['@odata.nextLink'];
    }

    return deltaLink;
  }

  async getMessage(
    account: ProviderAccount,
    providerMessageId: string,
  ): Promise<NormalizedMessage> {
    const message = await this.request<GraphMessage>(
      account,
      `/me/messages/${encodeURIComponent(providerMessageId)}?$select=${GRAPH_MESSAGE_SELECT}&$expand=attachments($select=id,name,contentType,size,isInline,contentId)`,
      { method: 'GET', op: 'messages.get' },
    );

    return normalizeGraphMessage(message);
  }

  /**
   * Streams one attachment.
   *
   * `/$value` returns the raw bytes rather than a base64 blob wrapped in JSON,
   * so this is genuinely streamed — unlike Gmail, where the whole attachment
   * arrives in one response and the stream has to be constructed to keep the
   * port's contract honest.
   */
  async getAttachment(
    account: ProviderAccount,
    providerMessageId: string,
    providerAttachmentId: string,
  ): Promise<Readable> {
    const token = await this.accessToken(account);
    const url =
      `${this.baseUrl}/me/messages/${encodeURIComponent(providerMessageId)}` +
      `/attachments/${encodeURIComponent(providerAttachmentId)}/$value`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new AppError('PROVIDER_ERROR', 'Could not reach Microsoft Graph', {
        context: { accountId: account.id, op: 'attachments.get' },
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) {
      throw mapGraphError(
        { status: response.status, message: 'Attachment fetch failed' },
        { accountId: account.id, op: 'attachments.get' },
      );
    }

    if (!response.body) {
      throw new AppError('NOT_FOUND', 'Attachment had no content', {
        context: { accountId: account.id },
      });
    }

    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  /* --------------------------------- send ---------------------------------- */

  /**
   * Sends through the user's own mailbox.
   *
   * Two steps rather than `/me/sendMail`, and the reason is the `SendResult`:
   * `sendMail` answers 202 with an empty body, so a caller learns nothing about
   * what was sent — no message id, no conversation id, and no way to thread a
   * future reply to it. Creating the draft first returns the resource, and the
   * send that follows is a separate call on a known id.
   *
   * The draft is created from MIME we composed rather than from Graph's JSON
   * message shape, because JSON has nowhere to put `In-Reply-To` and
   * `References` — the headers every non-Outlook client threads on (ADR 0003).
   *
   * `messageIdHeader` is read back rather than assumed. Gmail preserves the
   * `Message-ID` in an uploaded MIME; Graph assigns its own. Storing ours would
   * mean a reply to this reply arrives quoting an id we never see again, and the
   * thread resolver would fall back to guessing.
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

    const draft = await this.request<GraphMessage>(account, '/me/messages', {
      method: 'POST',
      op: 'messages.createFromMime',
      // Graph reads a MIME upload only when the content type says so; with
      // `application/json` it would try to parse base64 as a message resource.
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(composed.raw).toString('base64'),
    });

    if (!draft.id) {
      throw new AppError('PROVIDER_ERROR', 'Graph created no draft', {
        context: { accountId: account.id },
        retryable: true,
      });
    }

    await this.request<void>(account, `/me/messages/${encodeURIComponent(draft.id)}/send`, {
      method: 'POST',
      op: 'messages.send',
    });

    return {
      providerMessageId: draft.id,
      providerThreadId: draft.conversationId ?? message.providerThreadId ?? '',
      // What Graph actually put on the wire, falling back to ours only when it
      // did not say.
      messageIdHeader: draft.internetMessageId ?? composed.messageId,
      sentAt: new Date(),
    };
  }

  /* -------------------------------- mutate --------------------------------- */

  async mutate(
    account: ProviderAccount,
    providerMessageId: string,
    operation: MailOperation,
  ): Promise<void> {
    const id = encodeURIComponent(providerMessageId);

    switch (operation.kind) {
      case 'archive':
        // Outlook archives by moving. `archive` is a well-known folder name, so
        // this works without looking the folder id up first.
        return this.move(account, id, 'archive', 'mutate.archive');

      case 'unarchive':
        // Symmetrical with archive, and by the same well-known folder name.
        return this.move(account, id, 'inbox', 'mutate.unarchive');

      case 'delete':
        if (operation.permanent) {
          // Irreversible, and not reachable from a WhatsApp command — only from
          // an explicit account-deletion flow.
          await this.request<void>(account, `/me/messages/${id}`, {
            method: 'DELETE',
            op: 'mutate.delete',
          });
          return;
        }
        // Graph's DELETE *is* a move to Deleted Items for mail, but naming the
        // destination keeps the two verbs visibly different at this call site.
        return this.move(account, id, 'deleteditems', 'mutate.trash');

      case 'markRead':
        return this.patch(account, id, { isRead: operation.read }, 'mutate.markRead');

      case 'star':
        // Outlook has no star. Its flag is the same gesture and the same intent.
        return this.patch(
          account,
          id,
          { flag: { flagStatus: operation.starred ? 'flagged' : 'notFlagged' } },
          'mutate.star',
        );

      case 'spam':
        return this.move(account, id, operation.isSpam ? 'junkemail' : 'inbox', 'mutate.spam');

      case 'label': {
        // Categories are Outlook's labels, and Graph replaces the whole array on
        // PATCH rather than merging — so the current set has to be read first or
        // adding one category silently removes the rest.
        const current = await this.request<{ categories?: string[] }>(
          account,
          `/me/messages/${id}?$select=categories`,
          { method: 'GET', op: 'mutate.label.read' },
        );

        const next = new Set(current.categories ?? []);
        for (const add of operation.add ?? []) next.add(add);
        for (const remove of operation.remove ?? []) next.delete(remove);

        return this.patch(account, id, { categories: [...next] }, 'mutate.label');
      }
    }
  }

  /* --------------------------------- labels -------------------------------- */

  /**
   * Outlook's master category list.
   *
   * Categories have no ids of their own — the display name *is* the identifier,
   * and `mutate` writes names into the `categories` array. So `id` and `name`
   * come back equal here, which is not a shortcut: it is the difference between
   * the two mailboxes that the `MailLabel` shape exists to absorb. Graph does
   * return a GUID per category, and using it would be the bug — patching a
   * message with a GUID produces a category nobody can see.
   */
  async listLabels(account: ProviderAccount): Promise<MailLabel[]> {
    const response = await this.request<{ value?: Array<{ displayName?: string }> }>(
      account,
      '/me/outlook/masterCategories',
      { method: 'GET', op: 'labels.list' },
    );

    return (response.value ?? [])
      .filter((category) => category.displayName)
      .map((category) => ({ id: category.displayName!, name: category.displayName! }));
  }

  async createLabel(account: ProviderAccount, name: string): Promise<MailLabel> {
    await this.request<{ displayName?: string }>(account, '/me/outlook/masterCategories', {
      method: 'POST',
      op: 'labels.create',
      // A colour is required by the API. `preset0` is the first of the
      // twenty-five Outlook offers; leaving it out is rejected outright.
      body: JSON.stringify({ displayName: name, color: 'preset0' }),
    });

    return { id: name, name };
  }

  private async patch(
    account: ProviderAccount,
    id: string,
    body: Record<string, unknown>,
    op: string,
  ): Promise<void> {
    await this.request<void>(account, `/me/messages/${id}`, {
      method: 'PATCH',
      op,
      body: JSON.stringify(body),
    });
  }

  private async move(
    account: ProviderAccount,
    id: string,
    destinationId: string,
    op: string,
  ): Promise<void> {
    await this.request<void>(account, `/me/messages/${id}/move`, {
      method: 'POST',
      op,
      body: JSON.stringify({ destinationId }),
    });
  }

  /* --------------------------------- oauth --------------------------------- */

  /**
   * The consent URL.
   *
   * `offline_access` is what returns a refresh token — the equivalent of
   * Google's `access_type=offline`, and just as easy to omit and not notice
   * until the connection dies an hour later. `prompt=consent` makes a returning
   * user's grant come back with one too.
   */
  authorizationUrl(state: string, scopes: string[] = GRAPH_SCOPES): string {
    const tenant = this.options.tenantId ?? 'common';
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      response_type: 'code',
      redirect_uri: this.options.redirectUri,
      response_mode: 'query',
      scope: scopes.join(' '),
      state,
      prompt: 'consent',
    });

    return `${this.authority}/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
    scopes: string[];
  }> {
    const token = await this.token(
      new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.options.redirectUri,
        scope: GRAPH_SCOPES.join(' '),
      }),
      { op: 'exchangeCode' },
    );

    if (!token.refresh_token) {
      // Without one we cannot act on the mailbox beyond the first hour, so this
      // is a hard failure at connect time rather than a mystery later.
      throw new AppError('PROVIDER_ERROR', 'Microsoft returned no refresh token', {
        publicMessage:
          'We could not complete the connection. Please try again and accept the offline access request.',
        retryable: false,
      });
    }

    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + (token.expires_in ?? 3_600) * 1_000),
      scopes: (token.scope ?? '').split(' ').filter(Boolean),
    };
  }
}

/** The delta feed for the inbox, which is the only folder we watch. */
const DELTA_PATH = "/me/mailFolders('inbox')/messages/delta";

/**
 * How long a new subscription should last.
 *
 * Graph caps mail subscriptions at 4 230 minutes — just under three days. Asking
 * for the maximum minus an hour leaves room for clock skew between us and
 * Microsoft, which otherwise turns into a 400 that only appears in production.
 */
function subscriptionExpiry(): Date {
  return new Date(Date.now() + (4_230 - 60) * 60_000);
}

/**
 * The narrowest scopes that support read, send and mutation.
 *
 * `offline_access` is not optional: without it the grant lasts one hour.
 */
export const GRAPH_SCOPES = [
  'offline_access',
  'openid',
  'email',
  'profile',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface GraphSubscription {
  id?: string;
  expirationDateTime?: string;
}

interface GraphDeltaEntry {
  id?: string;
  conversationId?: string;
  categories?: string[];
  '@removed'?: { reason?: string };
}

interface GraphDeltaPage {
  value?: GraphDeltaEntry[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}
