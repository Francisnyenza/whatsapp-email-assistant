import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { ConfigService } from '../config/config.service.js';
import { RedisService } from './redis.service.js';
import { RateLimiter, clientAddress, type RateLimitScope } from './rate-limit.js';

/**
 * Applies the limits, and chooses which bucket a request falls in.
 *
 * Mounted after the metrics middleware so a rejection is counted like any other
 * response — a 429 that no metric can see is exactly the kind of thing this
 * file exists to stop being invisible.
 */

/** Paths where a burst is an attack rather than a busy user. */
const AUTH_PREFIXES = ['/v1/auth/signin', '/v1/auth/signup', '/v1/auth/refresh', '/v1/auth/2fa'];

/** Provider callbacks. Counted as a whole rather than per address — see `rateLimitKey`. */
const WEBHOOK_PREFIX = '/webhooks/';

/**
 * Never limited.
 *
 * A throttled liveness probe is a pod Kubernetes kills during exactly the
 * traffic spike the limit is there to absorb, and a throttled `/metrics` blinds
 * the monitoring while it happens.
 */
const EXEMPT_PREFIXES = ['/health', '/metrics'];

export function scopeFor(path: string): RateLimitScope | null {
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return null;
  if (WEBHOOK_PREFIX && path.startsWith(WEBHOOK_PREFIX)) return 'webhook';
  if (AUTH_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'auth';
  return 'global';
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly limiter: RateLimiter;

  constructor(
    config: ConfigService,
    redis: RedisService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    this.limiter = new RateLimiter(
      redis.client,
      {
        global: config.env.RATE_LIMIT_GLOBAL_PER_MIN,
        auth: config.env.RATE_LIMIT_AUTH_PER_MIN,
        webhook: config.env.RATE_LIMIT_WEBHOOK_PER_MIN,
      },
      this.logger,
    );
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const scope = scopeFor(req.path);
    if (!scope) {
      next();
      return;
    }

    const address = clientAddress(req.headers as Record<string, unknown>, req.socket.remoteAddress);

    void this.limiter.consume(scope, address).then((decision) => {
      if (decision.limit > 0) {
        res.setHeader('RateLimit-Limit', decision.limit);
        res.setHeader('RateLimit-Remaining', Math.max(decision.limit - decision.count, 0));
        res.setHeader('RateLimit-Reset', decision.resetSeconds);
      }

      if (decision.allowed) {
        next();
        return;
      }

      // 429 to a provider is the right answer and not a lost message: Meta and
      // Google both redeliver on it, which is exactly the backpressure a
      // webhook flood needs. A 200 here would drop the message for good.
      this.logger.warn(
        { event: 'ratelimit.rejected', scope, path: req.path, count: decision.count },
        'Rate limit exceeded',
      );

      res.setHeader('Retry-After', decision.resetSeconds);
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          // No count, no limit, no window. A rejection that reports the
          // remaining budget is a rejection that tells an attacker exactly how
          // to pace themselves.
          message: 'Too many requests. Please try again shortly.',
        },
      });
    });
  }
}
