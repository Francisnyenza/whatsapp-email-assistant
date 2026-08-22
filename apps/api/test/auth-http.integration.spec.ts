import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@wea/db';

/**
 * Sign in, refresh, sign out — over HTTP, against the compiled app.
 *
 * This is the test that was missing, and its absence had a cost. The API
 * required the refresh token in the request body; the dashboard sent no body
 * and relied on a cookie; nothing set a cookie. Every refresh the dashboard
 * made answered 400, so a signed-in user was signed out fifteen minutes later,
 * every time — and both suites were green, because the API tests post a body
 * and the dashboard tests stub `fetch`. Two suites describing different
 * products, neither one run against the other.
 *
 * So this one runs the real Nest app on a real port and talks to it the way a
 * browser does: no body on refresh, and whatever cookie the previous response
 * set. Nothing here knows what the controller does internally, which is the
 * point — it asks the question the two unit suites could not.
 *
 * The middleware wired in `main.ts` (metrics, rate limiting) is not present:
 * `NestFactory.create` builds the module, and those are mounted by hand around
 * it. That is deliberate here — a rate limit would make this suite flaky — and
 * it is why this file makes no claim about them.
 */

const DIST = new URL('../dist/', import.meta.url);
const built = existsSync(new URL('main.js', DIST));
const dbUrl = process.env['TEST_DATABASE_URL'];
const runnable = built && Boolean(dbUrl);

const FAKE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  API_BASE_URL: 'http://127.0.0.1:3001',
  WEB_BASE_URL: 'http://127.0.0.1:3000',
  DATABASE_URL: dbUrl ?? '',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
  S3_BUCKET: 'wea-test',
  ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 8).toString('base64'),
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  WHATSAPP_PHONE_NUMBER_ID: '1',
  WHATSAPP_ACCESS_TOKEN: 't',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'v',
  WHATSAPP_APP_SECRET: 's',
  AI_PRIMARY_PROVIDER: 'none',
};

interface App {
  listen: (port: number) => Promise<void>;
  getUrl: () => Promise<string>;
  close: () => Promise<void>;
}

/** The one cookie this suite cares about, kept the way a browser would. */
function jarFrom(response: Response, previous?: string): string | undefined {
  const header = response.headers.get('set-cookie');
  if (!header) return previous;

  const pair = header.split(';')[0];
  if (!pair) return previous;

  // `name=` with Max-Age=0 is a deletion.
  return pair.endsWith('=') ? undefined : pair;
}

describe.skipIf(!runnable)('auth over HTTP (compiled app, real database)', () => {
  let app: App;
  let base: string;
  let prisma: PrismaClient;
  let saved: NodeJS.ProcessEnv;

  const email = `http-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'CorrectHorseBattery9!';

  beforeAll(async () => {
    saved = { ...process.env };
    Object.assign(process.env, FAKE_ENV);

    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = (await import(new URL('app.module.js', DIST).href)) as {
      AppModule: unknown;
    };

    app = (await NestFactory.create(AppModule as never, {
      abortOnError: false,
      logger: false,
    })) as unknown as App;

    // Port 0: the OS picks a free one, so this cannot collide with a dev server.
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  }, 30_000);

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email } }).catch(() => undefined);
    await prisma?.$disconnect();
    await app?.close();
    process.env = saved;
  });

  it('sets a refresh cookie on sign-up', async () => {
    const response = await fetch(`${base}/v1/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    expect(response.status).toBe(201);

    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refreshes on the cookie alone, with no body', async () => {
    // Exactly what `apps/web/src/lib/api.ts` sends. This returned 400 until the
    // cookie existed, and 400 is what signed everyone out.
    const signIn = await fetch(`${base}/v1/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookie = jarFrom(signIn);
    expect(cookie).toBeDefined();

    const refreshed = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: cookie! },
    });

    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { accessToken?: string };
    expect(body.accessToken).toBeTruthy();
  });

  it('rotates the cookie on every refresh', async () => {
    const signIn = await fetch(`${base}/v1/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const first = jarFrom(signIn);
    const refreshed = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: first! },
    });
    const second = jarFrom(refreshed, first);

    // If the response did not replace the cookie, the browser keeps sending the
    // old one — and the *next* refresh presents an already-rotated token, which
    // the API correctly reads as theft and answers by revoking everything.
    expect(second).not.toBe(first);
  });

  it('treats a replayed cookie as theft and revokes the family', async () => {
    // Invariant 8, exercised through the cookie rather than through a body.
    const signIn = await fetch(`${base}/v1/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const stolen = jarFrom(signIn)!;
    const legitimate = jarFrom(
      await fetch(`${base}/v1/auth/refresh`, { method: 'POST', headers: { cookie: stolen } }),
    )!;

    // The thief replays the old one.
    const replay = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: stolen },
    });
    expect(replay.status).toBe(401);

    // And the real client is signed out too, which is the whole design: the
    // user re-authenticates once, the attacker is out.
    const after = await fetch(`${base}/v1/auth/refresh`, {
      method: 'POST',
      headers: { cookie: legitimate },
    });
    expect(after.status).toBe(401);
  });

  it('clears the cookie on sign-out', async () => {
    const signIn = await fetch(`${base}/v1/auth/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const cookie = jarFrom(signIn)!;
    const { accessToken } = (await signIn.json()) as { accessToken: string };

    const out = await fetch(`${base}/v1/auth/signout`, {
      method: 'POST',
      headers: {
        cookie,
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });

    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    // Cleared on the same Path it was set on, or the browser keeps the original
    // and the next page load signs the user back in.
    expect(out.headers.get('set-cookie')).toContain('Path=/v1/auth');
  });
});
