import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  api,
  endpoints,
  setAccessToken,
  hasAccessToken,
  apiBaseUrl,
  type ApiError,
} from '../src/lib/api';

/**
 * The dashboard's HTTP client.
 *
 * Most of this file is about the three decisions the client's own comment
 * claims, because a comment that says "the token lives in memory" is worth
 * nothing on its own — the next person to touch this file needs something that
 * breaks when they stop being true.
 *
 * The refresh behaviour is the part that repays the effort. It sits between two
 * failures that are both invisible in a browser: a refresh loop looks like a
 * hung page rather than an error, and a concurrent refresh looks like a working
 * page right up until the API revokes every session the user has.
 */

describe('the access token', () => {
  it('is never handed to localStorage', async () => {
    // A regression guard rather than a proof — it fails when somebody adds
    // persistence, which is the moment worth catching. A token in localStorage
    // survives a tab close, which is exactly the property that turns any XSS on
    // this origin into a permanent account takeover.
    const store = storageSpy();

    stubFetch(() => ok({ accessToken: 'from-signin' }));
    await endpoints.signIn('a@example.com', 'hunter2');
    setAccessToken('from-signin');
    await endpoints.me();

    expect(store.setItem).not.toHaveBeenCalled();
  });

  it('rides on the request once it is set', async () => {
    setAccessToken('tok-1');
    const calls = stubFetch(() => ok({ id: 'u1' }));

    await endpoints.me();

    expect(headersOf(calls[0]!)['authorization']).toBe('Bearer tok-1');
  });

  it('is left off entirely when there is none', async () => {
    // Not `Bearer null`. An API that sees a malformed bearer is entitled to
    // treat it as a bad credential rather than as an anonymous request.
    const calls = stubFetch(() => ok({ ok: true }));

    await api('/v1/anything');

    expect(headersOf(calls[0]!)).not.toHaveProperty('authorization');
  });
});

describe('every request', () => {
  it('carries credentials, because the refresh token is an HttpOnly cookie', async () => {
    const calls = stubFetch(() => ok({}));

    await endpoints.me();

    expect(calls[0]!.init.credentials).toBe('include');
  });

  it('declares JSON only when it is sending some', async () => {
    const calls = stubFetch(() => ok({ accessToken: 'x' }));

    await endpoints.signIn('a@example.com', 'pw');
    await endpoints.me();

    expect(headersOf(calls[0]!)['content-type']).toBe('application/json');
    expect(headersOf(calls[1]!)).not.toHaveProperty('content-type');
  });

  it('goes to the configured base URL', async () => {
    const calls = stubFetch(() => ok({}));

    await endpoints.me();

    expect(calls[0]!.url).toBe(`${apiBaseUrl}/v1/auth/me`);
  });
});

describe('a 401', () => {
  it('refreshes once and retries once, with the new token', async () => {
    setAccessToken('stale');
    const calls = stubFetch((url) => {
      if (url.endsWith('/v1/auth/refresh')) return ok({ accessToken: 'fresh' });
      return calls.length === 1 ? unauthorized() : ok({ id: 'u1' });
    });

    await expect(endpoints.me()).resolves.toEqual({ id: 'u1' });

    expect(calls.map((c) => c.url)).toEqual([
      `${apiBaseUrl}/v1/auth/me`,
      `${apiBaseUrl}/v1/auth/refresh`,
      `${apiBaseUrl}/v1/auth/me`,
    ]);
    expect(headersOf(calls[2]!)['authorization']).toBe('Bearer fresh');
  });

  it('does not refresh a second time when the retry is also refused', async () => {
    // The loop this prevents is not a slow page, it is an unbounded pair of
    // requests that looks to the API like an attack and to the user like a hang.
    //
    // The budget below is the point of the test as much as the assertions are.
    // A retry that kept refreshing would spin on microtasks alone, which starves
    // the timer vitest's own timeout runs on — so without a stub that refuses to
    // play along, this test would hang the suite forever rather than fail it,
    // and a hung CI job is a worse signal than a red one.
    setAccessToken('stale');
    const calls = stubFetch((url) => {
      if (calls.length > 6) throw new Error(`refresh loop: ${calls.length} requests and counting`);
      return url.endsWith('/v1/auth/refresh') ? ok({ accessToken: 'fresh' }) : unauthorized();
    });

    await expect(endpoints.me()).rejects.toMatchObject({ status: 401 });

    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.url.endsWith('/v1/auth/refresh'))).toHaveLength(1);
  });

  it('surfaces the original 401 when the refresh token is dead', async () => {
    setAccessToken('stale');
    const calls = stubFetch(() => unauthorized());

    await expect(endpoints.me()).rejects.toMatchObject({ status: 401 });

    expect(calls).toHaveLength(2);
    expect(hasAccessToken()).toBe(false);
  });

  it('refreshes without presenting the token that was just refused', async () => {
    // The cookie is the credential here. Sending the dead bearer alongside it
    // invites an API that checks the header first to refuse the refresh too.
    setAccessToken('stale');
    let seen = 0;
    const calls = stubFetch((url) => {
      if (url.endsWith('/v1/auth/refresh')) return ok({ accessToken: 'fresh' });
      return seen++ === 0 ? unauthorized() : ok({ id: 'u1' });
    });

    await endpoints.me();

    const refresh = calls.find((c) => c.url.endsWith('/v1/auth/refresh'))!;
    expect(headersOf(refresh)).not.toHaveProperty('authorization');
    expect(refresh.init.credentials).toBe('include');
  });
});

describe('concurrent 401s', () => {
  it('share a single refresh', async () => {
    // Refresh tokens rotate on use. Six widgets each rotating means five present
    // an already-rotated token, and an API that is doing its job reads that as a
    // stolen-token family and revokes every session the user has. The bug would
    // present as "the dashboard signs me out when I open it".
    setAccessToken('stale');
    let refused = 0;
    const calls = stubFetch(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) {
        await tick();
        return ok({ accessToken: 'fresh' });
      }
      return refused++ < 6 ? unauthorized() : ok({ id: 'u1' });
    });

    await Promise.all(Array.from({ length: 6 }, () => endpoints.me()));

    expect(calls.filter((c) => c.url.endsWith('/v1/auth/refresh'))).toHaveLength(1);
  });

  it('all of them see the refreshed token', async () => {
    setAccessToken('stale');
    let refused = 0;
    const calls = stubFetch(async (url) => {
      if (url.endsWith('/v1/auth/refresh')) {
        await tick();
        return ok({ accessToken: 'fresh' });
      }
      return refused++ < 3 ? unauthorized() : ok({ id: 'u1' });
    });

    const results = await Promise.all(Array.from({ length: 3 }, () => endpoints.me()));

    expect(results).toEqual([{ id: 'u1' }, { id: 'u1' }, { id: 'u1' }]);
    const retries = calls.filter((c) => c.url.endsWith('/v1/auth/me')).slice(3);
    for (const retry of retries) expect(headersOf(retry)['authorization']).toBe('Bearer fresh');
  });

  it('lets a later 401 refresh again, rather than reusing a settled attempt', async () => {
    // The shared promise is per-burst. A token that expires an hour later must
    // still be refreshable, which it is not if the promise is cached forever.
    setAccessToken('stale');
    const calls = stubFetch((url) => {
      if (url.endsWith('/v1/auth/refresh')) return ok({ accessToken: 'fresh' });
      return calls.filter((c) => c.url.endsWith('/v1/auth/me')).length % 2 === 1
        ? unauthorized()
        : ok({ id: 'u1' });
    });

    await endpoints.me();
    await endpoints.me();

    expect(calls.filter((c) => c.url.endsWith('/v1/auth/refresh'))).toHaveLength(2);
  });
});

describe('when a refresh answers strangely', () => {
  it('treats a 200 with no token as a failure rather than a success', async () => {
    setAccessToken('stale');
    stubFetch((url) => (url.endsWith('/v1/auth/refresh') ? ok({}) : unauthorized()));

    await expect(endpoints.me()).rejects.toMatchObject({ status: 401 });
    expect(hasAccessToken()).toBe(false);
  });

  it('clears the token when the network fails, instead of acting on a stale one', async () => {
    // A network failure is not a signed-out user, but it is also not a reason to
    // keep asserting a credential we can no longer prove is good. The sign-in
    // screen is recoverable; acting on a stale token is not.
    setAccessToken('stale');
    stubFetch((url) => {
      if (url.endsWith('/v1/auth/refresh')) return Promise.reject(new Error('offline'));
      return unauthorized();
    });

    await expect(endpoints.me()).rejects.toMatchObject({ status: 401 });
    expect(hasAccessToken()).toBe(false);
  });
});

describe('signing in', () => {
  it('does not treat a rejected password as an expired session', async () => {
    // Retrying would present the same wrong password twice, which spends the
    // user's lockout budget at double rate for no possible benefit.
    const calls = stubFetch(() => unauthorized());

    await expect(endpoints.signIn('a@example.com', 'wrong')).rejects.toMatchObject({ status: 401 });

    expect(calls).toHaveLength(1);
  });

  it('sends the credentials as JSON', async () => {
    const calls = stubFetch(() => ok({ accessToken: 'tok' }));

    await endpoints.signIn('a@example.com', 'pw');

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      email: 'a@example.com',
      password: 'pw',
    });
  });
});

describe('responses without a body', () => {
  it('resolves a 204 rather than failing to parse it', async () => {
    // `Response.json()` on an empty body throws, which would turn a successful
    // disconnect into an error toast and leave the user clicking it again.
    const calls = stubFetch(() => new Response(null, { status: 204 }));

    await expect(endpoints.disconnect('acct-1')).resolves.toBeUndefined();

    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toBe(`${apiBaseUrl}/v1/accounts/acct-1`);
  });
});

describe('errors', () => {
  it('prefers the message the API chose to show a user', async () => {
    stubFetch(() =>
      json(409, {
        error: {
          code: 'ALREADY_CONNECTED',
          message: 'unique_violation on email_accounts_key',
          publicMessage: 'That mailbox is already connected.',
        },
      }),
    );

    const error = await failure(endpoints.accounts());

    expect(error.message).toBe('That mailbox is already connected.');
    expect(error.code).toBe('ALREADY_CONNECTED');
    expect(error.status).toBe(409);
  });

  it('falls back to the internal message when there is no public one', async () => {
    stubFetch(() => json(400, { error: { code: 'VALIDATION_FAILED', message: 'digestTimes' } }));

    const error = await failure(endpoints.accounts());

    expect(error.message).toBe('digestTimes');
  });

  it('still reports the status when the body is not JSON at all', async () => {
    // A proxy timing out answers with HTML. The status is the only thing left
    // worth telling the user.
    stubFetch(() => new Response('<html>504</html>', { status: 504 }));

    const error = await failure(endpoints.accounts());

    expect(error.message).toContain('504');
    expect(error.status).toBe(504);
  });
});

describe('the endpoints', () => {
  it('patches only the settings it was given', async () => {
    const calls = stubFetch(() => ok({}));

    await endpoints.updatePreferences({ notificationMode: 'digest' });

    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ notificationMode: 'digest' });
  });

  it('encodes the return path it asks consent to come back to', async () => {
    // Unencoded, a `?` or `&` in the path would be read as another query
    // parameter — and `returnTo` is a value the API validates before it
    // redirects, so mangling it means a failed connect rather than an open one.
    const calls = stubFetch(() => ok({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }));

    await endpoints.connect('google', '/settings?tab=accounts&x=1');

    expect(calls[0]!.url).toBe(
      `${apiBaseUrl}/v1/oauth/google/start?returnTo=${encodeURIComponent('/settings?tab=accounts&x=1')}`,
    );
  });

  it('omits the return path when there is none', async () => {
    const calls = stubFetch(() => ok({ url: 'https://login.microsoftonline.com/' }));

    await endpoints.connect('microsoft');

    expect(calls[0]!.url).toBe(`${apiBaseUrl}/v1/oauth/microsoft/start`);
  });
});

/* --------------------------------- helpers -------------------------------- */

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * The error a request produced, insisting there was one.
 *
 * A bare `.catch((e) => e)` hands back the *success* value when the request
 * unexpectedly resolves, and every assertion below it is then checking
 * properties of a response body — green, and testing nothing.
 */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected the request to fail, but it resolved');
}

function stubFetch(handler: (url: string) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url);
  }) as never;
  return calls;
}

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function ok(body: unknown): Response {
  return json(200, body);
}

function unauthorized(): Response {
  return json(401, { error: { code: 'UNAUTHORIZED', message: 'Token expired' } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function storageSpy() {
  const store = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: store, configurable: true });
  return store;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  setAccessToken(null);
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});
