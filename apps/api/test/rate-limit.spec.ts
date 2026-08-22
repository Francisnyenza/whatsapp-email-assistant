import { describe, it, expect, vi } from 'vitest';
import {
  RateLimiter,
  rateLimitKey,
  clientAddress,
  windowResetSeconds,
  WINDOW_SECONDS,
} from '../src/common/rate-limit.js';
import { scopeFor } from '../src/common/rate-limit.middleware.js';

/**
 * Rate limiting, which until now was three settings nothing read.
 *
 * `RATE_LIMIT_GLOBAL_PER_MIN`, `RATE_LIMIT_AUTH_PER_MIN` and
 * `RATE_LIMIT_WEBHOOK_PER_MIN` have been in `.env.example` since the first
 * phase and no code referenced any of them — the same shape as `KMS_PROVIDER`,
 * which four call sites ignored while the operator believed the key lived in a
 * managed service. A control that is documented and absent is worse than one
 * that is absent, because nobody goes looking for it.
 */

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** Redis, as far as the limiter is concerned: INCR then EXPIRE, in a MULTI. */
function fakeRedis(counts = new Map<string, number>(), fail = false) {
  return {
    multi: () => ({
      incr(key: string) {
        this.key = key;
        return this;
      },
      expire() {
        return this;
      },
      async exec() {
        if (fail) throw new Error('Redis is gone');
        const next = (counts.get(this.key as string) ?? 0) + 1;
        counts.set(this.key as string, next);
        return [[null, next]];
      },
      key: '' as string,
    }),
  } as never;
}

describe('counting a window', () => {
  it('allows up to the limit and refuses past it', async () => {
    const limiter = new RateLimiter(
      fakeRedis(),
      { global: 3, auth: 3, webhook: 3 },
      logger as never,
    );

    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push((await limiter.consume('auth', '203.0.113.7')).allowed);
    }

    expect(results).toEqual([true, true, true, false, false]);
  });

  it('counts a rejected request too', async () => {
    // Otherwise a client held exactly at the limit sends forever without ever
    // advancing the counter, and the window never means anything.
    const counts = new Map<string, number>();
    const limiter = new RateLimiter(
      fakeRedis(counts),
      { global: 1, auth: 1, webhook: 1 },
      logger as never,
    );

    await limiter.consume('auth', 'a');
    await limiter.consume('auth', 'a');
    const third = await limiter.consume('auth', 'a');

    expect(third.count).toBe(3);
  });

  it('keeps buckets apart, so a webhook flood cannot lock anyone out of signin', async () => {
    const counts = new Map<string, number>();
    const limiter = new RateLimiter(
      fakeRedis(counts),
      { global: 9, auth: 2, webhook: 9 },
      logger as never,
    );

    for (let i = 0; i < 9; i += 1) await limiter.consume('webhook', '203.0.113.7');

    expect((await limiter.consume('auth', '203.0.113.7')).allowed).toBe(true);
  });

  it('keeps clients apart', async () => {
    const counts = new Map<string, number>();
    const limiter = new RateLimiter(
      fakeRedis(counts),
      { global: 1, auth: 1, webhook: 1 },
      logger as never,
    );

    await limiter.consume('auth', '203.0.113.7');

    expect((await limiter.consume('auth', '198.51.100.4')).allowed).toBe(true);
  });

  it('treats a limit of zero as off, not as a wall', async () => {
    // The reading an operator setting it to zero intends. Blocking everything
    // would be a configuration change that takes the product down silently.
    const limiter = new RateLimiter(
      fakeRedis(),
      { global: 0, auth: 0, webhook: 0 },
      logger as never,
    );

    expect((await limiter.consume('auth', 'a')).allowed).toBe(true);
  });
});

describe('when Redis is unavailable', () => {
  it('fails open rather than locking everyone out', async () => {
    // Defence in depth, not the primary control — passwords are hashed, tokens
    // rotate, and refresh reuse revokes a whole family regardless. Failing
    // closed would turn a Redis blip into a total outage.
    const limiter = new RateLimiter(
      fakeRedis(new Map(), true),
      { global: 1, auth: 1, webhook: 1 },
      logger as never,
    );

    expect((await limiter.consume('auth', 'a')).allowed).toBe(true);
  });

  it('says so, so failing open is a visible state', async () => {
    logger.warn.mockClear();
    const limiter = new RateLimiter(
      fakeRedis(new Map(), true),
      { global: 1, auth: 1, webhook: 1 },
      logger as never,
    );

    await limiter.consume('auth', 'a');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ratelimit.unavailable' }),
      expect.any(String),
    );
  });
});

describe('the key a request counts against', () => {
  it('rolls over with the window, so nothing needs sweeping', () => {
    const first = rateLimitKey('auth', 'a', 60_000);
    const later = rateLimitKey('auth', 'a', 60_000 + WINDOW_SECONDS * 1_000);

    expect(first).not.toBe(later);
  });

  it('is stable within one window', () => {
    expect(rateLimitKey('auth', 'a', 61_000)).toBe(rateLimitKey('auth', 'a', 119_000));
  });

  it('ignores the address for webhooks', () => {
    // Meta delivers from a shared pool, so per-address counting would let one
    // tenant's traffic limit another's.
    expect(rateLimitKey('webhook', '203.0.113.7', 0)).toBe(
      rateLimitKey('webhook', '198.51.100.4', 0),
    );
  });

  it('does not ignore it anywhere else', () => {
    expect(rateLimitKey('auth', '203.0.113.7', 0)).not.toBe(
      rateLimitKey('auth', '198.51.100.4', 0),
    );
  });
});

describe('working out who is calling', () => {
  it('takes the nearest hop, not the client-supplied first one', () => {
    // Each proxy appends, so the rightmost entry was added by the hop we
    // actually trust. Taking the first would let a client pick its own bucket
    // by sending a header.
    expect(clientAddress({ 'x-forwarded-for': '10.0.0.9, 198.51.100.4, 203.0.113.7' })).toBe(
      '203.0.113.7',
    );
  });

  it('cannot be escaped by spoofing', () => {
    const spoofed = clientAddress({ 'x-forwarded-for': 'not-an-address' }, '203.0.113.7');
    const honest = clientAddress({}, '203.0.113.7');

    // A spoofed header moves the attacker into a bucket they do not control;
    // it does not give them a fresh one per request unless they vary it, which
    // is why this is not the only defence.
    expect(spoofed).not.toBe(honest);
    expect(honest).toBe('203.0.113.7');
  });

  it('handles a repeated header, which Node gives as an array', () => {
    expect(clientAddress({ 'x-forwarded-for': ['10.0.0.9', '203.0.113.7'] })).toBe('203.0.113.7');
  });

  it('falls back to the socket when there is no header', () => {
    expect(clientAddress({}, '203.0.113.7')).toBe('203.0.113.7');
  });

  it('never returns empty, which would put every anonymous request in one bucket silently', () => {
    expect(clientAddress({ 'x-forwarded-for': '  ,  ' })).toBe('unknown');
    expect(clientAddress({})).toBe('unknown');
  });
});

describe('which bucket a path falls in', () => {
  it.each([
    ['/v1/auth/signin', 'auth'],
    ['/v1/auth/signup', 'auth'],
    ['/v1/auth/refresh', 'auth'],
    ['/v1/auth/2fa/verify', 'auth'],
    ['/webhooks/whatsapp', 'webhook'],
    ['/webhooks/gmail', 'webhook'],
    ['/v1/accounts', 'global'],
    ['/v1/me', 'global'],
  ])('%s → %s', (path, scope) => {
    expect(scopeFor(path)).toBe(scope);
  });

  it.each(['/health/live', '/health/ready', '/metrics'])('never limits %s', (path) => {
    // A throttled liveness probe is a pod Kubernetes kills during exactly the
    // spike the limit exists to absorb; a throttled /metrics blinds the
    // monitoring while it happens.
    expect(scopeFor(path)).toBeNull();
  });
});

describe('the reset hint', () => {
  it('is within the window and never zero', () => {
    for (const now of [0, 1_000, 30_500, 59_999, 1_755_000_000_000]) {
      const seconds = windowResetSeconds(now);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(WINDOW_SECONDS);
    }
  });
});
