import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import { RateLimiter, rateLimitKey } from '../src/common/rate-limit.js';

/**
 * Does the limiter actually count, against a real Redis.
 *
 * The unit tests above use a fake that returns whatever the fake decides, which
 * answers "is the arithmetic right" and not "does Redis do what this assumes".
 * Only the second question has ever been wrong here: every BullMQ job id in the
 * product was built in a form BullMQ rejects, and two thousand tests agreed it
 * was fine because all of them stubbed the queue.
 *
 * So this one asks the second question. What it pins is the MULTI behaving as a
 * counter, the TTL actually being set — a key created without one lives forever
 * and the bucket never resets — and two limiters sharing a count, which is what
 * makes the limit a property of the deployment rather than of one replica.
 */

const REDIS_URL = process.env['REDIS_URL'];
const runnable = Boolean(REDIS_URL);

const logger = { warn: () => undefined, info: () => undefined } as never;

describe.skipIf(!runnable)('rate limiting against real Redis', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1 });
  });

  afterEach(async () => {
    const keys = await redis.keys('rl:*');
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('refuses the request after the limit', async () => {
    const limiter = new RateLimiter(redis, { global: 100, auth: 3, webhook: 100 }, logger);
    const who = `spec-${Date.now()}`;

    const allowed = [];
    for (let i = 0; i < 5; i += 1) {
      allowed.push((await limiter.consume('auth', who)).allowed);
    }

    expect(allowed).toEqual([true, true, true, false, false]);
  });

  it('sets a TTL, or the bucket never resets', async () => {
    // The failure this catches is a key created by INCR with no EXPIRE — which
    // happens if the two commands are not in one MULTI and Redis restarts
    // between them. The client stays blocked forever, and nothing says why.
    const limiter = new RateLimiter(redis, { global: 5, auth: 5, webhook: 5 }, logger);
    const who = `ttl-${Date.now()}`;

    await limiter.consume('auth', who);

    const ttl = await redis.ttl(rateLimitKey('auth', who));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('shares the count between replicas', async () => {
    // The whole reason this is in Redis rather than in memory. Two API pods
    // each counting to the limit means twice the limit, which is a limit that
    // changes meaning every time the deployment scales.
    const one = new RateLimiter(redis, { global: 5, auth: 2, webhook: 5 }, logger);
    const two = new RateLimiter(redis, { global: 5, auth: 2, webhook: 5 }, logger);
    const who = `shared-${Date.now()}`;

    expect((await one.consume('auth', who)).allowed).toBe(true);
    expect((await two.consume('auth', who)).allowed).toBe(true);
    expect((await one.consume('auth', who)).allowed).toBe(false);
  });

  it('lets a different client through while one is blocked', async () => {
    const limiter = new RateLimiter(redis, { global: 5, auth: 1, webhook: 5 }, logger);
    const stamp = Date.now();

    await limiter.consume('auth', `a-${stamp}`);
    await limiter.consume('auth', `a-${stamp}`);

    expect((await limiter.consume('auth', `b-${stamp}`)).allowed).toBe(true);
  });
});
