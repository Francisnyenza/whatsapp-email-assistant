/**
 * Fixed-window rate limiting, counted in Redis.
 *
 * `RATE_LIMIT_GLOBAL_PER_MIN`, `RATE_LIMIT_AUTH_PER_MIN` and
 * `RATE_LIMIT_WEBHOOK_PER_MIN` have been in `.env.example` since the first
 * phase, and nothing read any of them. Three settings that looked like a
 * control and were not — the same shape as `KMS_PROVIDER`, which four call
 * sites ignored while the operator believed the key lived in a managed service.
 *
 * The endpoint that needs this most is `/v1/auth/signin`. Without a limit it is
 * an oracle anyone can query at line rate: credential stuffing, and — because
 * signup reports whether an address is taken — user enumeration.
 *
 * Fixed window rather than sliding, deliberately. A sliding window costs a
 * sorted set per key with a trim on every request; a fixed window is one INCR
 * and one EXPIRE. The cost is that a client can send 2N requests across a
 * window boundary, which matters for a quota and does not matter for the thing
 * this is defending against: a burst at the boundary is still bounded, and an
 * attacker willing to pace themselves to N per minute is already slowed by
 * three orders of magnitude.
 *
 * **Fails open.** A limiter that fails closed turns a Redis blip into a total
 * outage, and this is defence in depth rather than the primary control —
 * passwords are hashed, tokens rotate, and refresh reuse revokes a whole family
 * regardless. Every failure is logged, so failing open is a visible state.
 */

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** The buckets, each with its own limit and its own key space. */
export type RateLimitScope = 'global' | 'auth' | 'webhook';

/** One minute, matching the `_PER_MIN` in every setting's name. */
export const WINDOW_SECONDS = 60;

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests used in this window, after counting the current one. */
  count: number;
  limit: number;
  /** Seconds until the window resets. What `Retry-After` gets. */
  resetSeconds: number;
}

/**
 * The key a request counts against.
 *
 * Scoped per bucket so a burst of webhooks cannot exhaust a user's auth budget,
 * and floored to the window so the key expires on its own — no sweeper, and a
 * Redis that loses the key loses at most one window.
 *
 * `identifier` is the client's address for `global` and `auth`. It is
 * deliberately *not* used for `webhook`: Meta delivers from a shared pool of
 * addresses, so per-address counting there would limit one tenant's traffic by
 * another's. The webhook bucket is a whole-endpoint ceiling instead.
 */
export function rateLimitKey(scope: RateLimitScope, identifier: string, now = Date.now()): string {
  const window = Math.floor(now / (WINDOW_SECONDS * 1_000));
  const subject = scope === 'webhook' ? 'all' : identifier;
  return `rl:${scope}:${subject}:${window}`;
}

/** Seconds left in the window `now` falls in. */
export function windowResetSeconds(now = Date.now()): number {
  const elapsed = Math.floor(now / 1_000) % WINDOW_SECONDS;
  return WINDOW_SECONDS - elapsed;
}

/**
 * The client's address, as far as it can be trusted.
 *
 * Behind an ingress every request arrives from the proxy, so the address has to
 * come from `X-Forwarded-For` — which is client-supplied and trivially spoofed.
 * Taking the **last** entry rather than the first is what makes it usable: each
 * proxy appends, so the rightmost entry is the one added by the hop we actually
 * trust, and everything to its left is whatever the client chose to send.
 *
 * A spoofed header therefore cannot let a client escape its own bucket; at
 * worst it counts against a bucket it does not control, which is why this is
 * not the only defence.
 */
export function clientAddress(headers: Record<string, unknown>, socketAddress?: string): string {
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;

  if (typeof raw === 'string' && raw.length > 0) {
    const hops = raw
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);

    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }

  return socketAddress ?? 'unknown';
}

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limits: Record<RateLimitScope, number>,
    private readonly logger: Logger,
  ) {}

  /**
   * Counts one request and says whether it may proceed.
   *
   * The INCR happens before the comparison, so a rejected request still counts
   * — otherwise a client held exactly at the limit could keep sending forever
   * without ever advancing the counter.
   *
   * A limit of `0` disables the bucket rather than blocking everything, which
   * is the reading an operator setting it to zero intends.
   */
  async consume(scope: RateLimitScope, identifier: string): Promise<RateLimitDecision> {
    const limit = this.limits[scope];
    const resetSeconds = windowResetSeconds();

    if (!Number.isFinite(limit) || limit <= 0) {
      return { allowed: true, count: 0, limit: 0, resetSeconds };
    }

    const key = rateLimitKey(scope, identifier);

    try {
      // Pipelined: the EXPIRE has to accompany the INCR or a key created at the
      // moment Redis restarts lives forever, and the bucket never resets.
      const replies = await this.redis.multi().incr(key).expire(key, WINDOW_SECONDS).exec();

      // `exec()` resolves to null when the transaction was discarded — a
      // connection dropped mid-MULTI. Destructuring that throws a TypeError
      // inside the catch below, which reaches the same fail-open answer by a
      // worse route; naming it means the log says what happened.
      const incr = replies?.[0];
      if (!incr) throw new Error('Redis discarded the rate-limit transaction');

      const [incrErr, count] = incr;
      if (incrErr) throw incrErr;
      if (typeof count !== 'number') throw new Error('Rate-limit counter is not a number');

      return { allowed: count <= limit, count, limit, resetSeconds };
    } catch (err) {
      // Open, and loudly. See the file comment: a limiter that fails closed
      // turns a Redis blip into a total outage.
      this.logger.warn(
        { event: 'ratelimit.unavailable', scope, err },
        'Rate limiting is not counting; allowing the request',
      );
      return { allowed: true, count: 0, limit, resetSeconds };
    }
  }
}
