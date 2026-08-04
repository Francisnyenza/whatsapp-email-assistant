import { Injectable, type OnModuleInit, type OnModuleDestroy, Inject } from '@nestjs/common';
import {
  PrismaClient,
  assertTenantIsolationEnforceable,
  withTenant,
  type TenantClient,
} from '@wea/db';
import type { Logger } from 'pino';
import { ConfigService } from '../config/config.service.js';

/**
 * The database connection.
 *
 * On boot it refuses to continue if the connection can bypass row-level
 * security. Postgres exempts superusers and BYPASSRLS roles from every policy,
 * so an app connected as the database owner has tenant isolation silently
 * disabled — the policies exist, `\d` shows them, and nothing is enforced. That
 * is a failure mode you discover during an incident, so it is a boot failure
 * instead.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly config: ConfigService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    super({ datasources: { db: { url: config.env.DATABASE_URL } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await assertTenantIsolationEnforceable(this, {
      // Development commonly reuses the owner role; warn there, refuse in
      // production.
      allowInsecure: !this.config.isProduction,
    });
    this.logger.info({ event: 'db.connected' }, 'Database connected');
  }

  /**
   * Runs work scoped to one user, with row-level security pinned for the whole
   * transaction. The only sanctioned way for request handlers to read user data.
   */
  forUser<T>(userId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return withTenant(this, userId, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
