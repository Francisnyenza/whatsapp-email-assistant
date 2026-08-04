import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/client/index.js';
import { withTenant, assertTenantIsolationEnforceable } from '../src/index.js';
import { AppError } from '@wea/shared';

/**
 * Tenant isolation, verified against a real Postgres.
 *
 * These assertions are the reason row-level security exists in this schema, so
 * they run against the database rather than a mock. `TEST_DATABASE_URL` must
 * point at a connection using the restricted `wea_app` role — Postgres exempts
 * superusers from every policy, so running these as the owner would pass
 * vacuously and prove nothing.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('tenant isolation (RLS)', () => {
  let prisma: PrismaClient;
  const userA = randomUUID();
  const userB = randomUUID();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });

    // `users` itself is not tenant-scoped — a user row has no owner but itself.
    // Everything hanging off it is, so those rows have to be created inside the
    // owning user's context: the policy refuses them otherwise, which is the
    // behaviour the rest of this file asserts.
    for (const id of [userA, userB]) {
      await prisma.user.create({
        data: { id, email: `${id_short(id)}@example.com`, status: 'active' },
      });
      await withTenant(prisma, id, async (tx) => {
        await tx.userPreference.create({ data: { userId: id } });
        await tx.contact.create({
          data: { userId: id, emailAddress: `peer-${id_short(id)}@example.com` },
        });
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await prisma.$disconnect();
  });

  it('refuses a connection that can bypass row-level security', async () => {
    // The check that turns a misconfigured connection into a boot failure
    // instead of silently-disabled isolation.
    await expect(assertTenantIsolationEnforceable(prisma)).resolves.toBeUndefined();
  });

  it('shows nothing when no tenant context is set', async () => {
    const rows = await prisma.userPreference.findMany();
    expect(rows).toHaveLength(0);
  });

  it('shows only the scoped user’s rows', async () => {
    const forA = await withTenant(prisma, userA, (tx) => tx.userPreference.findMany());
    expect(forA).toHaveLength(1);
    expect(forA[0]?.userId).toBe(userA);

    const forB = await withTenant(prisma, userB, (tx) => tx.userPreference.findMany());
    expect(forB).toHaveLength(1);
    expect(forB[0]?.userId).toBe(userB);
  });

  it('returns nothing when a query explicitly asks for another tenant', async () => {
    // The failure this exists to catch: a `where` clause built from an
    // unvalidated request parameter.
    const leaked = await withTenant(prisma, userA, (tx) =>
      tx.contact.findMany({ where: { userId: userB } }),
    );
    expect(leaked).toHaveLength(0);
  });

  it('refuses a write that would create a row owned by another tenant', async () => {
    await expect(
      withTenant(prisma, userA, (tx) =>
        tx.contact.create({
          data: { userId: userB, emailAddress: 'smuggled@example.com' },
        }),
      ),
    ).rejects.toThrow();

    // And nothing was written.
    const count = await withTenant(prisma, userB, (tx) =>
      tx.contact.count({ where: { emailAddress: 'smuggled@example.com' } }),
    );
    expect(count).toBe(0);
  });

  it('does not leak tenant context to the next transaction on the same connection', async () => {
    // SET LOCAL is transaction-scoped. If it were SET, a pooled connection would
    // carry one user's context into the next request.
    await withTenant(prisma, userA, (tx) => tx.userPreference.findMany());
    const afterwards = await prisma.userPreference.findMany();
    expect(afterwards).toHaveLength(0);
  });

  it('rejects a tenant id that is not a UUID', async () => {
    // SET LOCAL takes no bind parameters, so this validation is what stands
    // between the setting and SQL injection.
    for (const bad of ["' OR '1'='1", 'not-a-uuid', '', '11111111']) {
      await expect(withTenant(prisma, bad, async () => 'unreachable')).rejects.toThrow(AppError);
    }
  });

  it('rolls back the whole transaction when the callback throws', async () => {
    const address = `rollback-${id_short(randomUUID())}@example.com`;

    await expect(
      withTenant(prisma, userA, async (tx) => {
        await tx.contact.create({ data: { userId: userA, emailAddress: address } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const found = await withTenant(prisma, userA, (tx) =>
      tx.contact.findMany({ where: { emailAddress: address } }),
    );
    expect(found).toHaveLength(0);
  });
});

function id_short(id: string): string {
  return id.slice(0, 8);
}
