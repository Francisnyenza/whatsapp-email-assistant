import { PrismaClient, Prisma } from '../generated/client/index.js';
import { AppError } from '@wea/shared';

export { Prisma };
export type { PrismaClient };

export interface CreateClientOptions {
  databaseUrl: string;
  /** Emits query timings at debug level. Never enable in production. */
  logQueries?: boolean;
  /** Queries slower than this are logged as warnings. */
  slowQueryMs?: number;
  onLog?: (level: 'query' | 'warn' | 'error', payload: Record<string, unknown>) => void;
}

/**
 * Builds the shared Prisma client.
 *
 * Query text is logged only when explicitly asked for, and parameters are never
 * logged at all — a Prisma query log includes the values, which for this system
 * means email addresses and body ciphertext.
 */
export function createPrismaClient(options: CreateClientOptions): PrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
      ...(options.logQueries ? ([{ level: 'query', emit: 'event' }] as const) : []),
    ],
  });

  const slowQueryMs = options.slowQueryMs ?? 500;
  const log = options.onLog;

  if (log) {
    client.$on('warn' as never, (e: { message: string }) => log('warn', { message: e.message }));
    client.$on('error' as never, (e: { message: string }) => log('error', { message: e.message }));

    if (options.logQueries) {
      client.$on('query' as never, (e: { query: string; duration: number }) => {
        if (e.duration >= slowQueryMs) {
          // Query text only — `e.params` holds the actual values.
          log('warn', { slowQuery: e.query, durationMs: e.duration });
        }
      });
    }
  }

  return client;
}

/**
 * Refuses to run against a connection that can bypass row-level security.
 *
 * Postgres exempts superusers and `BYPASSRLS` roles from every policy, so an
 * application connected as the database owner has RLS silently disabled — the
 * policies exist, the tests pass, and nothing is enforced. This check turns that
 * into a boot failure rather than a finding in an incident review.
 *
 * Call once at startup in the API and worker.
 */
export async function assertTenantIsolationEnforceable(
  client: PrismaClient,
  { allowInsecure = false }: { allowInsecure?: boolean } = {},
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ is_superuser: boolean; bypassrls: boolean }>>`
    SELECT rolsuper AS is_superuser, rolbypassrls AS bypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `;

  const role = rows[0];
  if (!role) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'Could not determine the database role');
  }

  if (role.is_superuser || role.bypassrls) {
    const message =
      'Database connection uses a role that bypasses row-level security. ' +
      'Connect as the restricted application role (wea_app), not the owner.';
    if (!allowInsecure) throw new AppError('INTERNAL', message);
    // Development commonly reuses the owner role; make the gap loud.
    console.warn(`[db] ${message}`);
  }
}

/** True when the error is Postgres's unique-constraint violation. */
export function isUniqueViolation(err: unknown, target?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!target) return true;
  const fields = err.meta?.['target'];
  return Array.isArray(fields) ? fields.includes(target) : fields === target;
}

/** True when the row a write depended on has disappeared. */
export function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/**
 * A retryable database failure — serialization conflicts and lost connections,
 * which a queued job should try again rather than dead-letter.
 */
export function isRetryableDbError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P1001/P1002 unreachable, P1017 connection closed, P2034 write conflict.
    return ['P1001', 'P1002', 'P1017', 'P2024', 'P2034'].includes(err.code);
  }
  return err instanceof Prisma.PrismaClientInitializationError;
}
