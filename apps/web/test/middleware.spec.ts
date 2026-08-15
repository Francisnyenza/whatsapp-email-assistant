import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../src/middleware';

/**
 * The Content-Security-Policy.
 *
 * Worth testing because every failure mode here is silent. A policy with a
 * reused nonce is a policy an attacker can satisfy; one set only on the
 * response breaks the page's own scripts in production while working perfectly
 * in dev; one that falls back to a wildcard on a bad env var looks identical to
 * one that works, right up until it is the only thing standing between an
 * injected tag and someone's mailbox.
 */

const ORIGINAL = process.env['NEXT_PUBLIC_API_BASE_URL'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['NEXT_PUBLIC_API_BASE_URL'];
  else process.env['NEXT_PUBLIC_API_BASE_URL'] = ORIGINAL;
});

describe('the nonce', () => {
  it('is different on every request', async () => {
    // A nonce reused across responses is guessable from any cached page, which
    // makes the whole policy decorative.
    const nonces = new Set(await Promise.all(Array.from({ length: 20 }, () => nonceOf(run()))));

    expect(nonces.size).toBe(20);
  });

  it('reaches the request as well as the response', async () => {
    // Next stamps its hydration scripts with the nonce it reads off the
    // *request* CSP. Set it only on the response and every script Next emits is
    // unnonced — a blank page in production and a working one in dev, which is
    // the worst possible way to find out.
    const response = run();

    expect(response.headers.get('content-security-policy')).toBe(
      requestHeader(response, 'content-security-policy'),
    );
    expect(requestHeader(response, 'x-nonce')).toBe(await nonceOf(response));
  });
});

describe('what script may do', () => {
  it('permits only nonced script', async () => {
    const csp = directive(run(), 'script-src');

    expect(csp).toContain("'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('allows eval in development only', () => {
    // The HMR runtime needs it. Shipping it would hand an injected string
    // straight back to the parser, which is most of what a CSP exists to stop.
    expect(directive(run(), 'script-src')).toContain("'unsafe-eval'");
    expect(inProduction(() => directive(run(), 'script-src'))).not.toContain("'unsafe-eval'");
  });
});

describe('where the page may talk', () => {
  it('names the API origin, and only its origin', async () => {
    process.env['NEXT_PUBLIC_API_BASE_URL'] = 'https://api.example.com/v1/base';

    expect(directive(run(), 'connect-src')).toContain('https://api.example.com');
    // The path is not part of an origin, and including it would be a policy the
    // browser silently reinterprets rather than one we chose.
    expect(directive(run(), 'connect-src')).not.toContain('/v1/base');
  });

  it('fails closed on a malformed base URL rather than opening up', async () => {
    // The tempting fallback is `*`. A misconfigured deploy that cannot load
    // data gets fixed in minutes; one that permits every origin does not get
    // noticed at all.
    process.env['NEXT_PUBLIC_API_BASE_URL'] = 'not-a-url';

    const connect = directive(run(), 'connect-src');
    expect(connect).toContain("'none'");
    expect(connect).not.toContain('*');
  });

  it('does not permit websockets in production', () => {
    expect(inProduction(() => directive(run(), 'connect-src'))).not.toContain('ws:');
  });
});

describe('the directives that stop script-free attacks', () => {
  it('pins the base URI, so an injected <base> cannot redirect every script', () => {
    expect(directive(run(), 'base-uri')).toContain("'none'");
  });

  it('pins form actions, so a rewritten form cannot post the password elsewhere', () => {
    expect(directive(run(), 'form-action')).toContain("'self'");
  });

  it('refuses to be framed', () => {
    expect(directive(run(), 'frame-ancestors')).toContain("'none'");
  });

  it('forbids plugins and nested frames outright', () => {
    expect(directive(run(), 'object-src')).toContain("'none'");
    expect(directive(run(), 'frame-src')).toContain("'none'");
  });

  it('upgrades insecure requests in production only', () => {
    // In dev the app is served over plain http on localhost, and upgrading
    // would make it unreachable.
    expect(cspOf(run())).not.toContain('upgrade-insecure-requests');
    expect(inProduction(() => cspOf(run()))).toContain('upgrade-insecure-requests');
  });
});

describe('what the middleware runs on', () => {
  it('skips static output, which carries no markup to inject into', () => {
    // Next compiles the matcher itself; this one is a raw regex group, so
    // evaluating it as a regex is a close enough stand-in to catch the mistake
    // that matters — a negative lookahead written so it excludes nothing.
    const matcher = config.matcher[0]!;
    const pattern = new RegExp(`^${matcher}$`);

    expect(pattern.test('/_next/static/chunks/main.js')).toBe(false);
    expect(pattern.test('/favicon.ico')).toBe(false);
    expect(pattern.test('/settings')).toBe(true);
    expect(pattern.test('/')).toBe(true);
  });
});

/* --------------------------------- helpers -------------------------------- */

function run(path = '/'): ReturnType<typeof middleware> {
  return middleware(new NextRequest(new Request(`https://app.example.com${path}`)));
}

function cspOf(response: ReturnType<typeof middleware>): string {
  return response.headers.get('content-security-policy') ?? '';
}

function directive(response: ReturnType<typeof middleware>, name: string): string {
  const found = cspOf(response)
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));

  expect(found, `CSP is missing ${name}`).toBeDefined();
  return found!;
}

async function nonceOf(response: ReturnType<typeof middleware>): Promise<string> {
  return /'nonce-([^']+)'/.exec(cspOf(response))?.[1] ?? '';
}

function requestHeader(response: ReturnType<typeof middleware>, name: string): string | null {
  // `NextResponse.next({ request: { headers } })` encodes the overridden request
  // headers into a response header rather than mutating the request, so this is
  // how the request side is observable at all.
  const overrides = response.headers.get('x-middleware-override-headers');
  if (!overrides?.split(',').includes(name)) return null;
  return response.headers.get(`x-middleware-request-${name}`);
}

function inProduction<T>(fn: () => T): T {
  // `NODE_ENV` is not an ordinary property on `process.env` — Node rejects
  // `defineProperty` on it — so this goes through vitest's stub rather than an
  // assignment.
  vi.stubEnv('NODE_ENV', 'production');
  try {
    return fn();
  } finally {
    vi.unstubAllEnvs();
  }
}
