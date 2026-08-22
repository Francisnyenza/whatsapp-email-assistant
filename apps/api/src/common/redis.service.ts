import { Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ConfigService } from '../config/config.service.js';

/**
 * One Redis connection for things that are not queues.
 *
 * BullMQ owns its own connections and will not share them — it holds several in
 * blocking reads. The rate limiter needs ordinary commands, so it needs its own
 * client, and one shared client is better than one per caller: `ioredis`
 * pipelines automatically, so a single connection is not a bottleneck at this
 * request volume, and every extra connection counts against `maxclients`.
 *
 * **Connected eagerly, on purpose.** The first version was lazy, and the first
 * request after every start arrived before the socket was up: with
 * `enableOfflineQueue` off the command failed, the limiter failed open — which
 * is correct — and that request went uncounted. Observed rather than reasoned
 * about, by sending fourteen requests at a limit of ten and getting eleven
 * through. A rate limit with a hole at every deploy is a rate limit an attacker
 * can widen by causing restarts.
 */
const READY_TIMEOUT_MS = 2_000;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.env.REDIS_URL, {
      // Commands fail fast rather than queueing forever when Redis is gone.
      // The rate limiter fails open on error, and it can only do that if the
      // error actually arrives.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    // Without a handler an emitted `error` is an unhandled event, which Node
    // turns into a process-level throw for an EventEmitter named `error`.
    // Swallowing it here is safe because `ioredis` reconnects on its own — the
    // handler exists to stop the process dying, not to hide the failure, which
    // the limiter logs when a command actually fails.
    this.client.on('error', () => undefined);
  }

  /**
   * Gives the connection a head start, without making it a boot dependency.
   *
   * Waits briefly for `ready` and gives up quietly. Awaiting it indefinitely
   * would mean a Redis outage becomes a CrashLoopBackOff instead of a pod that
   * starts, reports unready, and can be diagnosed — and `ioredis` keeps
   * retrying in the background either way, so a timeout here costs nothing
   * beyond the hole it was closing.
   */
  async onModuleInit(): Promise<void> {
    if (this.client.status === 'ready') return;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.client.off('ready', done);
        resolve();
      };

      const timer = setTimeout(done, READY_TIMEOUT_MS);
      // `unref` so a slow Redis cannot hold the process open on shutdown.
      timer.unref?.();
      this.client.once('ready', done);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
