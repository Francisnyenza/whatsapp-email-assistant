import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { google } from 'googleapis';
import type { AddressInfo } from 'node:net';
import { GmailProvider } from '../src/providers/gmail.provider.js';
import type { ProviderAccount, OutboundMessage } from '../src/provider.js';

/**
 * What the SDK actually sends, and actually throws.
 *
 * Every other test of this adapter answers a different question. The error
 * tests build `{ code: 401, errors: [{ reason: 'authError' }] }` by hand and
 * check the mapping; the send tests never leave `composeMime`. Both assume a
 * shape for what `googleapis` does at the boundary, and nothing has ever
 * checked the assumption — which is precisely the arrangement that let sixteen
 * BullMQ job ids be built in a form BullMQ rejects, with two thousand tests
 * agreeing they were fine.
 *
 * So this one runs the real client against a local HTTP server. `googleapis`
 * builds the request, signs it, parses the response and constructs the error;
 * the only thing replaced is Google. That makes it the test that fails when a
 * major version changes `err.code` from a number to a string — at which point
 * every branch in `mapGmailError` would quietly fall through to the default,
 * and a revoked grant would be retried forever instead of prompting a
 * reconnect.
 *
 * `apiBaseUrl` is a constructor option and not an environment variable, unlike
 * the WhatsApp equivalent. Requests here carry a mailbox OAuth token; a config
 * key that redirects them is a config key that exfiltrates them, and the seam
 * costs nothing when only code can reach it.
 *
 * There is no Graph equivalent of this file and there should not be. That
 * adapter speaks HTTP directly and already takes a `fetchImpl`, so
 * `graph-provider.spec.ts` is already at this boundary — there is no
 * third-party client between it and the wire whose contract could drift.
 */

/** A Gmail error body, copied from the shape the API really returns. */
function errorBody(code: number, reason: string, message: string) {
  return {
    error: {
      code,
      message,
      errors: [{ message, domain: 'global', reason }],
      status: code === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
    },
  };
}

interface Reply {
  status: number;
  body: unknown;
}

describe('the Gmail adapter over real HTTP', () => {
  let server: http.Server;
  let baseUrl: string;

  /** What the next request should get. Set per test. */
  let reply: Reply = { status: 200, body: {} };
  /** What the server saw, so the request itself can be asserted on. */
  let seen: { method?: string; url?: string; body?: string } = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, body };
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const account: ProviderAccount = {
    id: 'account-1',
    userId: 'user-1',
    emailAddress: 'me@example.com',
    accessToken: 'ya29.a-token',
    refreshToken: '1//a-refresh-token',
    // Well in the future, so the client does not try to refresh against a
    // token endpoint this server is not pretending to be.
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
  } as ProviderAccount;

  function provider(): GmailProvider {
    return new GmailProvider({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://127.0.0.1:3001/v1/oauth/google/callback',
      apiBaseUrl: baseUrl,
    });
  }

  const message: OutboundMessage = {
    to: [{ address: 'sarah.chen@acme.com', name: 'Sarah Chen' }],
    subject: 'Re: Q3 report',
    bodyText: 'On it.',
    inReplyTo: '<CAF=q3@mail.acme.com>',
    references: ['<root@acme.com>', '<CAF=q3@mail.acme.com>'],
    providerThreadId: 'thread-77',
  } as OutboundMessage;

  describe('sending', () => {
    it('puts the message where Gmail expects it', async () => {
      reply = { status: 200, body: { id: 'gm-1', threadId: 'thread-77' } };

      await provider().send(account, message);

      expect(seen.method).toBe('POST');
      expect(seen.url).toContain('/gmail/v1/users/me/messages/send');
    });

    it('encodes the MIME as base64url, which is not base64', async () => {
      // Gmail requires the URL-safe alphabet. Standard base64 is accepted by
      // some endpoints and rejected by this one, and the difference only shows
      // up when the message happens to contain a `+` or `/` — so most of the
      // time, and then not.
      reply = { status: 200, body: { id: 'gm-1', threadId: 'thread-77' } };

      await provider().send(account, message);

      const raw = (JSON.parse(seen.body!) as { raw: string }).raw;
      const decoded = Buffer.from(raw, 'base64url').toString('utf8');

      // Guarding the guard: `not.toMatch(/[+/=]/)` passes for free on a payload
      // whose standard encoding happens to contain none of them, which would
      // make this assertion look like it checks something while checking
      // nothing. So first confirm this message is one where the two alphabets
      // actually differ.
      expect(Buffer.from(decoded, 'utf8').toString('base64')).toMatch(/[+/=]/);
      expect(raw).not.toMatch(/[+/=]/);
      expect(decoded).toContain('Subject: Re: Q3 report');
      expect(decoded).toContain('In-Reply-To: <CAF=q3@mail.acme.com>');
      expect(decoded).toContain('From: me@example.com');
    });

    it('carries the thread id, so Gmail groups it as a reply', async () => {
      reply = { status: 200, body: { id: 'gm-1', threadId: 'thread-77' } };

      await provider().send(account, message);

      expect(JSON.parse(seen.body!)).toMatchObject({ threadId: 'thread-77' });
    });

    it('reads the ids back out of the response', async () => {
      reply = { status: 200, body: { id: 'gm-99', threadId: 'thread-88' } };

      const result = await provider().send(account, message);

      expect(result.providerMessageId).toBe('gm-99');
      expect(result.providerThreadId).toBe('thread-88');
      // Ours, not Gmail's: the header we minted is what a future reply threads
      // onto, and Gmail does not return it.
      expect(result.messageIdHeader).toMatch(/^<.+@example\.com>$/);
    });

    it('sends an Authorization header, not the token in the query', async () => {
      reply = { status: 200, body: { id: 'gm-1' } };

      await provider().send(account, message);

      expect(seen.url).not.toContain('ya29.');
    });
  });

  describe('what the SDK throws', () => {
    it('maps a 401 to a reconnect rather than a retry', async () => {
      // The mapping the offline tests already assert — checked here against an
      // error `googleapis` built, rather than one this file built.
      reply = { status: 401, body: errorBody(401, 'authError', 'Invalid Credentials') };

      await expect(provider().verifyAccess(account)).rejects.toMatchObject({
        code: 'PROVIDER_UNAUTHORIZED',
        retryable: false,
      });
    });

    it('retries a 403 that means "slow down"', async () => {
      reply = {
        status: 403,
        body: errorBody(403, 'rateLimitExceeded', 'User-rate limit exceeded'),
      };

      await expect(provider().verifyAccess(account)).rejects.toMatchObject({ retryable: true });
    });

    it('does not retry a 403 that means "you may not do this"', async () => {
      // Gmail uses one status for both. Treating them alike is either a hot
      // loop or a silently dropped user, which is why the mapping reads
      // `reason` — and why it matters that `reason` really is where the SDK
      // puts it.
      reply = {
        status: 403,
        body: errorBody(403, 'forbidden', 'Insufficient Permission'),
      };

      await expect(provider().verifyAccess(account)).rejects.toMatchObject({ retryable: false });
    });

    it('retries a 429', async () => {
      reply = { status: 429, body: errorBody(429, 'rateLimitExceeded', 'Too many requests') };

      await expect(provider().verifyAccess(account)).rejects.toMatchObject({ retryable: true });
    });

    it('retries a 500, which is Google having a bad minute', async () => {
      reply = { status: 500, body: errorBody(500, 'backendError', 'Backend Error') };

      await expect(provider().verifyAccess(account)).rejects.toMatchObject({ retryable: true });
    });

    it('does not leak the provider’s wording to the user', async () => {
      reply = { status: 401, body: errorBody(401, 'authError', 'Invalid Credentials') };

      await expect(provider().verifyAccess(account)).rejects.toMatchObject({
        publicMessage: expect.not.stringContaining('Invalid Credentials') as unknown as string,
      });
    });
  });

  describe('the error shape the mapping depends on', () => {
    it('arrives as a numeric code with a reason array', async () => {
      // Pinning the SDK contract directly, below the adapter, because that is
      // what the assertion is about: `mapGmailError` branches on `err.code`
      // being a number and `err.errors[0].reason` being a string. If a major
      // version moves the status to `err.response.status` only, or stringifies
      // the code, every branch falls through to the default — and a revoked
      // grant becomes a permanent retry loop instead of a reconnect prompt.
      //
      // Going through the provider here would not work and would not be the
      // point: it returns an `AppError`, whose `code` is deliberately a string.
      reply = { status: 403, body: errorBody(403, 'rateLimitExceeded', 'slow down') };

      const gmail = google.gmail({ version: 'v1', rootUrl: baseUrl, auth: 'unused' });

      const raw = await gmail.users
        .getProfile({ userId: 'me' })
        .then(() => {
          expect.unreachable('the server answered 403');
        })
        .catch((err: unknown) => err as { code?: unknown; errors?: Array<{ reason?: unknown }> });

      expect(typeof raw.code).toBe('number');
      expect(raw.code).toBe(403);
      expect(typeof raw.errors?.[0]?.reason).toBe('string');
      expect(raw.errors?.[0]?.reason).toBe('rateLimitExceeded');
    });
  });
});
