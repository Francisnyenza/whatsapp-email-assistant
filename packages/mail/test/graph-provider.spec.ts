import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@wea/shared';
import { GraphProvider, mapGraphError, isDeltaTokenExpired } from '../src/index.js';
import type { ProviderAccount } from '../src/provider.js';

/**
 * The Graph adapter.
 *
 * Everything asserted here is a place where Graph differs from Gmail in a way
 * that makes the obvious code quietly wrong: renewal that creates instead of
 * extending, a cursor that is a URL rather than a number, deletions reported as
 * present entries, and a Message-ID that Graph replaces rather than preserves.
 *
 * The fetch stub honours the *contract* rather than the signature — it routes on
 * URL and method and returns the shapes Graph actually returns, including the
 * empty-bodied 202. A stub that answered every call with `{}` would prove the
 * code compiles and nothing else, which is the failure this project has already
 * been bitten by once.
 */

const account: ProviderAccount = {
  id: 'acct-1',
  userId: 'user-1',
  emailAddress: 'me@example.com',
  accessToken: 'valid-token',
  refreshToken: 'refresh-token',
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
};

interface Route {
  match: (url: string, method: string) => boolean;
  status?: number;
  body?: unknown;
  /** For the `$value` attachment stream. */
  raw?: string;
}

/** A fetch that routes like Graph does, and records every call. */
function graph(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body?: string; headers?: any }> = [];

  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init.body, headers: init.headers });

    const route = routes.find((r) => r.match(url, method));
    if (!route) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => ({ error: { code: 'ItemNotFound', message: `no route for ${url}` } }),
      };
    }

    const status = route.status ?? 200;

    return {
      ok: status < 400,
      status,
      headers: { get: () => null },
      json: async () => route.body ?? {},
      body: route.raw
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(route.raw));
              controller.close();
            },
          })
        : null,
    };
  });

  return { fetchImpl, calls };
}

const provider = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  new GraphProvider({
    clientId: 'app',
    clientSecret: 'secret',
    redirectUri: 'https://example.com/cb',
    notificationUrl: 'https://example.com/webhooks/microsoft',
    clientState: 'shared-secret',
    fetchImpl,
    ...over,
  });

describe('subscriptions', () => {
  it('creates one, and takes a cursor from the delta channel', async () => {
    // A subscription says *that* something changed and never what, so the sync
    // position has to come from somewhere else.
    const { fetchImpl, calls } = graph([
      {
        match: (u, m) => u.includes('/subscriptions') && m === 'POST',
        body: { id: 'sub-1', expirationDateTime: '2026-08-07T09:00:00Z' },
      },
      {
        match: (u) => u.includes('/delta'),
        body: { value: [], '@odata.deltaLink': 'https://graph/delta?token=INITIAL' },
      },
    ]);

    const handle = await provider(fetchImpl as never).watch(account);

    expect(handle.subscriptionId).toBe('sub-1');
    expect(handle.cursor.value).toContain('token=INITIAL');

    const created = JSON.parse(calls.find((c) => c.method === 'POST')!.body!);
    expect(created.resource).toContain('inbox');
    expect(created.clientState).toBe('shared-secret');
  });

  it('asks for less than the maximum, leaving room for clock skew', async () => {
    // Graph caps mail subscriptions at 4 230 minutes and answers 400 for a
    // request past it — a failure that only appears in production.
    const { fetchImpl, calls } = graph([
      { match: (u, m) => u.includes('/subscriptions') && m === 'POST', body: { id: 'sub-1' } },
      { match: (u) => u.includes('/delta'), body: { '@odata.deltaLink': 'https://graph/d' } },
    ]);

    await provider(fetchImpl as never).watch(account);

    const created = JSON.parse(calls.find((c) => c.method === 'POST')!.body!);
    const minutes = (new Date(created.expirationDateTime).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeLessThan(4_230);
    expect(minutes).toBeGreaterThan(4_000);
  });

  it('renews by extending, not by creating a second one', async () => {
    // The difference from Gmail that matters most. Gmail's watch is idempotent;
    // POSTing again here would deliver every notification twice and leak a
    // subscription every three days until the per-mailbox limit rejects one.
    const { fetchImpl, calls } = graph([
      {
        match: (u, m) => u.includes('/subscriptions/sub-1') && m === 'PATCH',
        body: { id: 'sub-1', expirationDateTime: '2026-08-07T09:00:00Z' },
      },
    ]);

    await provider(fetchImpl as never).renewWatch({
      ...account,
      config: { subscriptionId: 'sub-1' },
      syncCursor: 'https://graph/delta?token=EXISTING',
    });

    expect(calls.map((c) => c.method)).toEqual(['PATCH']);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('does not move the sync position when it renews', async () => {
    // Taking a fresh delta link here would skip every message that arrived
    // between the last sync and the renewal — mail lost by the very job that
    // exists to keep mail flowing.
    const { fetchImpl } = graph([
      {
        match: (u, m) => u.includes('/subscriptions/sub-1') && m === 'PATCH',
        body: { id: 'sub-1' },
      },
    ]);

    const handle = await provider(fetchImpl as never).renewWatch({
      ...account,
      config: { subscriptionId: 'sub-1' },
      syncCursor: 'https://graph/delta?token=EXISTING',
    });

    expect(handle.cursor.value).toBe('https://graph/delta?token=EXISTING');
  });

  it('creates one when the subscription has already lapsed', async () => {
    const { fetchImpl, calls } = graph([
      { match: (u, m) => u.includes('/subscriptions/sub-1') && m === 'PATCH', status: 404 },
      { match: (u, m) => u.endsWith('/subscriptions') && m === 'POST', body: { id: 'sub-2' } },
      { match: (u) => u.includes('/delta'), body: { '@odata.deltaLink': 'https://graph/d' } },
    ]);

    const handle = await provider(fetchImpl as never).renewWatch({
      ...account,
      config: { subscriptionId: 'sub-1' },
    });

    expect(handle.subscriptionId).toBe('sub-2');
    expect(calls.map((c) => c.method)).toContain('POST');
  });

  it('treats an already-gone subscription as successfully stopped', async () => {
    // Failing a disconnect over this would strand the account.
    const { fetchImpl } = graph([
      { match: (u, m) => u.includes('/subscriptions/sub-1') && m === 'DELETE', status: 404 },
    ]);

    await expect(
      provider(fetchImpl as never).stopWatch({ ...account, config: { subscriptionId: 'sub-1' } }),
    ).resolves.toBeUndefined();
  });
});

describe('delta sync', () => {
  it('follows the cursor as a URL rather than parsing it', async () => {
    const { fetchImpl, calls } = graph([
      {
        match: (u) => u.includes('token=A'),
        body: { value: [{ id: 'm1' }], '@odata.deltaLink': 'https://graph/delta?token=B' },
      },
    ]);

    const changes = provider(fetchImpl as never).fetchChanges(
      account,
      'https://graph/delta?token=A',
    );
    const collected = [];
    let next = await changes.next();
    for (; !next.done; next = await changes.next()) collected.push(next.value);

    expect(calls[0]!.url).toBe('https://graph/delta?token=A');
    expect(collected).toEqual([{ type: 'messageAdded', providerMessageId: 'm1' }]);
  });

  it('returns the delta link, never a next link', async () => {
    // A `nextLink` is a paging position: it expires in minutes and resumes
    // mid-walk. Storing one instead of the delta link is a mailbox that
    // silently stops syncing, which is the exact bug the return-value contract
    // exists to make hard.
    const { fetchImpl } = graph([
      {
        match: (u) => u.includes('token=A'),
        body: { value: [{ id: 'm1' }], '@odata.nextLink': 'https://graph/delta?page=2' },
      },
      {
        match: (u) => u.includes('page=2'),
        body: { value: [{ id: 'm2' }], '@odata.deltaLink': 'https://graph/delta?token=FINAL' },
      },
    ]);

    const changes = provider(fetchImpl as never).fetchChanges(
      account,
      'https://graph/delta?token=A',
    );

    const seen = [];
    let next = await changes.next();
    for (; !next.done; next = await changes.next()) seen.push(next.value);

    expect(seen).toHaveLength(2);
    expect(next.value).toBe('https://graph/delta?token=FINAL');
    expect(next.value).not.toContain('page=2');
  });

  it('recognises a deletion, which arrives as a present entry', async () => {
    // Graph reports deletions as an ordinary item carrying `@removed`, not as
    // an absence. Without the check every deletion looks like an update to a
    // message that no longer exists.
    const { fetchImpl } = graph([
      {
        match: (u) => u.includes('token=A'),
        body: {
          value: [
            { id: 'gone', '@removed': { reason: 'deleted' } },
            { id: 'here', conversationId: 'c1' },
          ],
          '@odata.deltaLink': 'https://graph/delta?token=B',
        },
      },
    ]);

    const changes = provider(fetchImpl as never).fetchChanges(
      account,
      'https://graph/delta?token=A',
    );

    const seen = [];
    let next = await changes.next();
    for (; !next.done; next = await changes.next()) seen.push(next.value);

    expect(seen).toEqual([
      { type: 'messageDeleted', providerMessageId: 'gone' },
      { type: 'messageAdded', providerMessageId: 'here', providerThreadId: 'c1' },
    ]);
  });

  it('walks to the end for an initial cursor rather than guessing one', async () => {
    // Graph has no "current position" endpoint, so the only way to get a
    // resumable link is to run the delta query out.
    const { fetchImpl, calls } = graph([
      {
        match: (u) => u.includes('/delta?$select=id'),
        body: { value: [{ id: 'm1' }], '@odata.nextLink': 'https://graph/delta?page=2' },
      },
      {
        match: (u) => u.includes('page=2'),
        body: { value: [], '@odata.deltaLink': 'https://graph/delta?token=START' },
      },
    ]);

    const cursor = await provider(fetchImpl as never).getInitialCursor(account);

    expect(cursor).toBe('https://graph/delta?token=START');
    // `$select=id` keeps the walk to identifiers instead of downloading the
    // whole mailbox to find out where the end is.
    expect(calls[0]!.url).toContain('$select=id');
  });

  it('returns nothing for a mailbox with no cursor rather than inventing one', async () => {
    const { fetchImpl } = graph([]);

    const changes = provider(fetchImpl as never).fetchChanges(account, null);
    expect((await changes.next()).value).toBeNull();
  });
});

describe('sending', () => {
  const sendRoutes = (draft: Record<string, unknown>) => [
    {
      match: (u: string, m: string) => u.endsWith('/me/messages') && m === 'POST',
      body: draft,
    },
    { match: (u: string) => u.includes('/send'), status: 202 },
  ];

  it('creates a draft from MIME, then sends it', async () => {
    // `/me/sendMail` answers 202 with an empty body, so a caller learns nothing
    // about what was sent — no message id, no conversation id, and no way to
    // thread a future reply to it.
    const { fetchImpl, calls } = graph(
      sendRoutes({ id: 'draft-1', conversationId: 'conv-1', internetMessageId: '<graph@out>' }),
    );

    await provider(fetchImpl as never).send(account, {
      to: [{ address: 'sarah@acme.com' }],
      subject: 'Re: Q3 report',
      bodyText: 'On it.',
      idempotencyKey: 'k1',
    });

    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/me/messages'),
      expect.stringContaining('/me/messages/draft-1/send'),
    ]);
  });

  it('uploads MIME with a content type Graph will read it as', async () => {
    // With `application/json` Graph tries to parse base64 as a message
    // resource, which fails in a way that reads like a malformed request.
    const { fetchImpl, calls } = graph(sendRoutes({ id: 'draft-1' }));

    await provider(fetchImpl as never).send(account, {
      to: [{ address: 'sarah@acme.com' }],
      subject: 'Hi',
      bodyText: 'Hello',
      idempotencyKey: 'k1',
    });

    expect(calls[0]!.headers['content-type']).toBe('text/plain');
  });

  it('carries the threading headers, which JSON has nowhere to put', async () => {
    const { fetchImpl, calls } = graph(sendRoutes({ id: 'draft-1' }));

    await provider(fetchImpl as never).send(account, {
      to: [{ address: 'sarah@acme.com' }],
      subject: 'Re: Q3 report',
      bodyText: 'On it.',
      inReplyTo: '<parent@acme.com>',
      references: ['<root@acme.com>', '<parent@acme.com>'],
      idempotencyKey: 'k1',
    });

    const mime = Buffer.from(calls[0]!.body!, 'base64').toString('utf8');
    expect(mime).toContain('In-Reply-To: <parent@acme.com>');
    expect(mime).toContain('References: <root@acme.com> <parent@acme.com>');
  });

  it('reports the Message-ID Graph assigned, not the one we composed', async () => {
    // Gmail preserves ours; Graph replaces it. Storing ours would mean a reply
    // to this reply quotes an id we never see again, and the thread resolver
    // falls back to guessing.
    const { fetchImpl } = graph(
      sendRoutes({ id: 'draft-1', conversationId: 'conv-1', internetMessageId: '<assigned@ms>' }),
    );

    const result = await provider(fetchImpl as never).send(account, {
      to: [{ address: 'sarah@acme.com' }],
      subject: 'Hi',
      bodyText: 'Hello',
      idempotencyKey: 'k1',
    });

    expect(result.messageIdHeader).toBe('<assigned@ms>');
    expect(result.providerMessageId).toBe('draft-1');
    expect(result.providerThreadId).toBe('conv-1');
  });

  it('falls back to our Message-ID only when Graph did not say', async () => {
    const { fetchImpl } = graph(sendRoutes({ id: 'draft-1' }));

    const result = await provider(fetchImpl as never).send(account, {
      to: [{ address: 'sarah@acme.com' }],
      subject: 'Hi',
      bodyText: 'Hello',
      idempotencyKey: 'k1',
    });

    expect(result.messageIdHeader).toMatch(/^<.+>$/);
  });

  it('carries no header that would reveal the channel', async () => {
    // The product promise: the recipient sees a normal email.
    const { fetchImpl, calls } = graph(sendRoutes({ id: 'draft-1' }));

    await provider(fetchImpl as never).send(account, {
      to: [{ address: 'sarah@acme.com' }],
      subject: 'Hi',
      bodyText: 'Hello',
      idempotencyKey: 'k1',
    });

    const mime = Buffer.from(calls[0]!.body!, 'base64').toString('utf8').toLowerCase();
    expect(mime).not.toContain('whatsapp');
  });
});

describe('mutations', () => {
  const ok = [{ match: () => true, status: 204 }];

  const mutate = async (operation: any) => {
    const { fetchImpl, calls } = graph(ok);
    await provider(fetchImpl as never).mutate(account, 'm1', operation);
    return calls;
  };

  it('archives by moving, which is what Outlook means by archiving', async () => {
    const calls = await mutate({ kind: 'archive' });

    expect(calls[0]!.url).toContain('/move');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ destinationId: 'archive' });
  });

  it('trashes by moving to Deleted Items, never by deleting', async () => {
    const calls = await mutate({ kind: 'delete', permanent: false });

    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ destinationId: 'deleteditems' });
  });

  it('deletes permanently only when explicitly asked', async () => {
    const calls = await mutate({ kind: 'delete', permanent: true });
    expect(calls[0]!.method).toBe('DELETE');
  });

  it('marks read and unread', async () => {
    expect(JSON.parse((await mutate({ kind: 'markRead', read: true }))[0]!.body!)).toEqual({
      isRead: true,
    });
    expect(JSON.parse((await mutate({ kind: 'markRead', read: false }))[0]!.body!)).toEqual({
      isRead: false,
    });
  });

  it('stars by flagging', async () => {
    expect(JSON.parse((await mutate({ kind: 'star', starred: true }))[0]!.body!)).toEqual({
      flag: { flagStatus: 'flagged' },
    });
  });

  it('reads categories before writing them, because PATCH replaces the array', async () => {
    // Graph does not merge. Adding one category with a bare PATCH silently
    // removes every other one the user had.
    const { fetchImpl, calls } = graph([
      {
        match: (u, m) => m === 'GET' && u.includes('$select=categories'),
        body: { categories: ['Blue category', 'Red category'] },
      },
      { match: (_u, m) => m === 'PATCH', status: 204 },
    ]);

    await provider(fetchImpl as never).mutate(account, 'm1', {
      kind: 'label',
      add: ['Green category'],
      remove: ['Red category'],
    });

    const patched = JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!);
    expect(patched.categories).toEqual(['Blue category', 'Green category']);
  });
});

describe('tokens', () => {
  it('refreshes an expired one and hands the new pair back to be persisted', async () => {
    // Without the callback the new token lives only in this process, and every
    // worker refreshes on every job — which Microsoft throttles hard.
    const onTokenRefresh = vi.fn().mockResolvedValue(undefined);
    const { fetchImpl } = graph([
      {
        match: (u) => u.includes('/oauth2/v2.0/token'),
        body: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3_600 },
      },
      { match: (u) => u.includes('/me'), body: { id: 'u1', mail: 'Me@Example.com' } },
    ]);

    await provider(fetchImpl as never, { onTokenRefresh }).verifyAccess({
      ...account,
      accessToken: 'stale',
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    expect(onTokenRefresh).toHaveBeenCalledWith(
      'acct-1',
      // Microsoft rotates refresh tokens; dropping the new one leaves a token
      // that stops working at an unpredictable point in the future.
      expect.objectContaining({ accessToken: 'fresh', refreshToken: 'rotated' }),
    );
  });

  it('refuses rather than retrying when there is nothing to refresh with', async () => {
    const { fetchImpl } = graph([]);
    const { refreshToken: _omitted, ...noRefresh } = account;

    await provider(fetchImpl as never)
      .verifyAccess({ ...noRefresh, tokenExpiresAt: new Date(Date.now() - 1_000) })
      .catch((err: AppError) => {
        expect(err.code).toBe('PROVIDER_UNAUTHORIZED');
        expect(err.retryable).toBe(false);
      });
    expect.assertions(2);
  });

  it('treats a revoked grant as final, not as an outage', async () => {
    const { fetchImpl } = graph([
      {
        match: (u) => u.includes('/oauth2/v2.0/token'),
        status: 400,
        body: { error: 'invalid_grant', error_description: 'consent revoked' },
      },
    ]);

    await provider(fetchImpl as never)
      .verifyAccess({ ...account, tokenExpiresAt: new Date(Date.now() - 1_000) })
      .catch((err: AppError) => {
        expect(err.code).toBe('PROVIDER_UNAUTHORIZED');
        expect(err.retryable).toBe(false);
      });
    expect.assertions(2);
  });

  it('prefers the directory id over the address as the account identity', async () => {
    // An address can change; the object id cannot, and it is what identifies
    // the mailbox on reconnect.
    const { fetchImpl } = graph([
      { match: (u) => u.includes('/me'), body: { id: 'obj-1', mail: 'Me@Example.com' } },
    ]);

    const identity = await provider(fetchImpl as never).verifyAccess(account);

    expect(identity).toEqual({ emailAddress: 'me@example.com', providerAccountId: 'obj-1' });
  });

  it('falls back to the principal name for a mailbox with no mail attribute', async () => {
    const { fetchImpl } = graph([
      {
        match: (u) => u.includes('/me'),
        body: { id: 'obj-1', mail: null, userPrincipalName: 'me@example.onmicrosoft.com' },
      },
    ]);

    const identity = await provider(fetchImpl as never).verifyAccess(account);
    expect(identity.emailAddress).toBe('me@example.onmicrosoft.com');
  });
});

describe('the consent URL', () => {
  it('asks for offline access, without which the grant lasts an hour', async () => {
    const url = provider(graph([]).fetchImpl as never).authorizationUrl('state-123');

    expect(url).toContain('offline_access');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('state=state-123');
  });
});

describe('which failures are worth retrying', () => {
  it.each([
    [401, '', 'PROVIDER_UNAUTHORIZED', false],
    [403, 'ApplicationThrottled', 'PROVIDER_RATE_LIMITED', true],
    [403, 'ErrorAccessDenied', 'PROVIDER_UNAUTHORIZED', false],
    [429, '', 'PROVIDER_RATE_LIMITED', true],
    [404, 'ItemNotFound', 'NOT_FOUND', false],
    [410, 'syncStateNotFound', 'CONFLICT', false],
    [500, '', 'PROVIDER_ERROR', true],
    [400, 'ErrorInvalidIdMalformed', 'PROVIDER_ERROR', false],
  ])('%i %s → %s (retryable %s)', (status, code, expected, retryable) => {
    const mapped = mapGraphError({ status, code, message: 'x' });

    expect(mapped.code).toBe(expected);
    expect(mapped.retryable).toBe(retryable);
  });

  it('separates throttling from refusal inside a 403', () => {
    // Graph uses 403 for both "slow down" and "you may not do this". Treating
    // them alike is either a hot loop or a user dropped for no reason.
    expect(mapGraphError({ status: 403, code: 'ApplicationThrottled' }).retryable).toBe(true);
    expect(mapGraphError({ status: 403, code: 'ErrorAccessDenied' }).retryable).toBe(false);
  });

  it('normalizes a non-object rather than dereferencing it', () => {
    // This runs inside catch blocks; throwing here turns a handled failure into
    // an unhandled one and takes the worker down.
    expect(mapGraphError(undefined).code).toBe('PROVIDER_ERROR');
    expect(mapGraphError('boom').message).toContain('boom');
  });

  it('passes an AppError through unchanged', () => {
    const original = new AppError('NOT_FOUND', 'gone');
    expect(mapGraphError(original)).toBe(original);
  });

  it('recognises an expired delta token, which is a resync and not an incident', () => {
    expect(isDeltaTokenExpired({ status: 410, code: 'syncStateNotFound' })).toBe(true);
    expect(isDeltaTokenExpired({ status: 500 })).toBe(false);
    expect(isDeltaTokenExpired(mapGraphError({ status: 410, code: 'syncStateNotFound' }))).toBe(
      true,
    );
  });
});

describe('labels', () => {
  it('returns categories with the display name as the id', async () => {
    // Categories have no ids of their own — the name *is* the identifier, and
    // `mutate` writes names into the `categories` array. Graph does return a
    // GUID per category, and using it would be the bug: a message patched with
    // a GUID gets a category nobody can see.
    const { fetchImpl } = graph([
      {
        match: (u, m) => m === 'GET' && u.includes('masterCategories'),
        body: {
          value: [
            { id: '9d1b-guid', displayName: 'Receipts', color: 'preset0' },
            { id: '3f2a-guid', displayName: 'Travel', color: 'preset4' },
          ],
        },
      },
    ]);

    const labels = await provider(fetchImpl as never).listLabels(account);

    expect(labels).toEqual([
      { id: 'Receipts', name: 'Receipts' },
      { id: 'Travel', name: 'Travel' },
    ]);
  });

  it('skips a category with no display name', async () => {
    const { fetchImpl } = graph([
      {
        match: (u, m) => m === 'GET' && u.includes('masterCategories'),
        body: { value: [{ id: 'x' }, { displayName: 'Receipts' }] },
      },
    ]);

    expect(await provider(fetchImpl as never).listLabels(account)).toHaveLength(1);
  });

  it('creates one with a colour, which Graph requires', async () => {
    const { fetchImpl, calls } = graph([
      { match: (u, m) => m === 'POST' && u.includes('masterCategories'), body: {} },
    ]);

    const created = await provider(fetchImpl as never).createLabel(account, 'Tax 2026');

    expect(JSON.parse(calls[0]!.body!)).toEqual({ displayName: 'Tax 2026', color: 'preset0' });
    expect(created).toEqual({ id: 'Tax 2026', name: 'Tax 2026' });
  });
});
