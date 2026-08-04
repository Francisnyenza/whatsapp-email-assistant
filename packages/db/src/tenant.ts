import { AppError } from '@wea/shared';
import type { PrismaClient, Prisma } from './client.js';

/**
 * Tenant-scoped database access.
 *
 * The repository layer already filters by `userId` on every query. That is the
 * belt. This is the braces: work runs inside a transaction that has told
 * Postgres whose data it is allowed to touch, so a query that forgets its
 * `where` clause returns nothing instead of another person's mail.
 *
 * Nothing here is optional in request-handling code. `withTenant` is the only
 * sanctioned way for the API and the per-user worker jobs to reach the database.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The subset of PrismaClient available inside a transaction. */
export type TenantClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$transaction' | '$on'>;

export interface WithTenantOptions {
  /** Overall transaction budget. Beyond this Postgres rolls back. */
  timeoutMs?: number;
  /** How long to wait for a connection from the pool. */
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Runs `fn` with row-level security pinned to one user.
 *
 * `SET LOCAL` is scoped to the surrounding transaction, so the setting cannot
 * leak to the next request that borrows the same pooled connection — the failure
 * mode that makes naive connection-level tenant context dangerous.
 *
 * @throws {AppError} when `userId` is not a UUID. Interpolating an unvalidated
 *   value into `SET LOCAL` would be an injection point, since Postgres does not
 *   accept a bind parameter there.
 */
export async function withTenant<T>(
  client: PrismaClient,
  userId: string,
  fn: (tx: TenantClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  if (!UUID.test(userId)) {
    throw new AppError('BAD_REQUEST', 'Tenant context requires a valid user id');
  }

  return client.$transaction(
    async (tx) => {
      // Prisma.raw is required because SET LOCAL takes no bind parameters. The
      // UUID check above is what makes this safe, so the two must stay together.
      await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userId}'`);
      return fn(tx as TenantClient);
    },
    {
      timeout: options.timeoutMs ?? 15_000,
      maxWait: options.maxWaitMs ?? 5_000,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    },
  );
}

/**
 * Escape hatch for work that legitimately spans users: the retention sweep,
 * queue reconciliation, admin tooling, migrations.
 *
 * Deliberately verbose. Every call site should be justifiable in review, and
 * `reason` is recorded so an audit can answer "what runs unscoped, and why".
 */
export async function withoutTenantScope<T>(
  client: PrismaClient,
  reason: CrossTenantReason,
  fn: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  void reason;
  return fn(client);
}

/**
 * The complete list of operations permitted to read across tenants. Adding a
 * member is a deliberate act, which is the point of an enum rather than a string.
 */
export type CrossTenantReason =
  | 'retention-sweep'
  | 'watch-renewal'
  | 'queue-reconciliation'
  | 'admin-console'
  | 'platform-analytics'
  | 'billing-reconciliation'
  | 'webhook-account-lookup'
  | 'migration';
