import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@wea/db';
import { AuditService } from '../src/common/audit.service.js';

/**
 * The audit trail against a real database.
 *
 * Two things can only be checked here. First that the row this service builds
 * is one Postgres accepts — the unit tests assert on the arguments handed to a
 * stubbed Prisma, which is a different question, and the only one that has ever
 * been wrong in this codebase.
 *
 * Second, and the reason this file exists at all: that the table is actually
 * append-only. `docs/status.md` has claimed since the schema was written that
 * `audit_logs` rejects UPDATE and DELETE at both the grant and the trigger
 * level, and nothing checked it. A trail a compromised API can edit is not a
 * trail — it is a log with extra steps — and that property is exactly the kind
 * that survives in a document long after a migration quietly drops it.
 *
 * `TEST_DATABASE_URL` must use the restricted `wea_app` role. As the owner
 * every assertion here passes vacuously, because the owner may do anything.
 */

const url = process.env['TEST_DATABASE_URL'];
const describeIfDb = url ? describe : describe.skip;

describeIfDb('the audit trail (real database)', () => {
  let prisma: PrismaClient;
  let audit: AuditService;

  const userId = randomUUID();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    audit = new AuditService(prisma as never, logger as never);

    await prisma.user.create({
      data: { id: userId, email: `audit-${userId.slice(0, 8)}@example.com`, status: 'active' },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    // The user goes; the audit rows do not. `onDelete: SetNull` on the relation
    // is what keeps a deleted account's trail readable, which is the whole
    // point of an audit log surviving the thing it audited.
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('writes a row Postgres accepts', async () => {
    await audit.record({
      action: 'auth.signin',
      userId,
      ipAddress: '203.0.113.7',
      userAgent: 'vitest',
      metadata: { twoFactorRequired: false },
    });

    const rows = await prisma.auditLog.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'auth.signin', success: true });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('writes an entry with no user at all', async () => {
    // The `userId` column is nullable so a sign-in against an address that does
    // not exist can still be recorded. If a migration ever makes it NOT NULL,
    // the most useful entry in the table becomes unwritable and this fails.
    const marker = `no-user-${randomUUID().slice(0, 8)}`;

    await audit.record({
      action: 'auth.signin',
      success: false,
      failureReason: 'no such account',
      metadata: { marker },
    });

    const found = await prisma.auditLog.findFirst({
      where: { userId: null, failureReason: 'no such account' },
      orderBy: { createdAt: 'desc' },
    });
    expect(found).not.toBeNull();
  });

  it('refuses an UPDATE, so the trail cannot be rewritten', async () => {
    await audit.record({ action: 'auth.signout', userId });

    await expect(
      prisma.auditLog.updateMany({ where: { userId }, data: { success: false } }),
    ).rejects.toThrow();
  });

  it('refuses a DELETE, so the trail cannot be erased', async () => {
    await audit.record({ action: 'auth.signout_all', userId });

    await expect(prisma.auditLog.deleteMany({ where: { userId } })).rejects.toThrow();
  });

  it('survives the account it describes being deleted, with the id intact', async () => {
    // Two properties at once, and the first one is why the second is possible.
    //
    // Deleting the user has to *work*. It did not: `user_id` carried a foreign
    // key with ON DELETE SET NULL, SET NULL is an UPDATE, and the append-only
    // trigger rejects every UPDATE — so any user with an audit row could not be
    // deleted at all. Nothing noticed while nothing wrote audit rows. The
    // migration `20260822000100_audit_trail_outlives_its_subject` drops the
    // constraint.
    //
    // And the id survives rather than being nulled, which is the better record:
    // an attacker who deletes an account must not thereby erase which account
    // did the thing, and "whose was this" is the first question asked about a
    // deleted one.
    const doomed = randomUUID();
    const marker = `account-${doomed.slice(0, 8)}`;
    await prisma.user.create({
      data: { id: doomed, email: `doomed-${doomed.slice(0, 8)}@example.com`, status: 'active' },
    });

    await audit.record({ action: 'account.connected', userId: doomed, resourceId: marker });
    await expect(prisma.user.delete({ where: { id: doomed } })).resolves.toBeTruthy();

    const survivor = await prisma.auditLog.findFirst({ where: { resourceId: marker } });
    expect(survivor).not.toBeNull();
    expect(survivor?.userId).toBe(doomed);
  });
});
