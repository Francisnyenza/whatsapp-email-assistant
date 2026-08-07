import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { WatchRepository } from '../src/repositories/watch.repository.js';

/**
 * Watch renewal against a real database.
 *
 * The thing being verified here is not the SQL — it is that a scheduled job
 * with no tenant can find out *which* mailboxes need renewing without gaining
 * the ability to read one. That property is enforced by Postgres, not by the
 * repository, so it can only be checked here.
 *
 * `TEST_DATABASE_URL` must use the restricted `wea_app` role. As the owner,
 * Postgres exempts the connection from every policy and the isolation
 * assertions below would pass without proving anything.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

const HOUR = 3_600_000;

describeIfDb('watch renewal (real database)', () => {
  let prisma: PrismaClient;
  let watches: WatchRepository;

  const alice = randomUUID();
  const bob = randomUUID();
  const aliceAccount = randomUUID();
  const bobAccount = randomUUID();

  const withTenant = <T>(userId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, userId, fn as never) as Promise<T>;

  async function seedAccount(
    userId: string,
    accountId: string,
    over: { watchExpiresAt?: Date | null; syncCursor?: string | null } = {},
  ) {
    const address = `${accountId.slice(0, 8)}@example.com`;

    await withTenant(userId, async (tx) => {
      await tx.emailAccount.create({
        data: {
          id: accountId,
          userId,
          provider: 'gmail',
          emailAddress: address,
          status: 'active',
          providerAccountId: `acct-${accountId.slice(0, 8)}`,
          accessTokenCipher: new Uint8Array([1]),
          accessTokenDek: new Uint8Array([1]),
          tokenKeyVersion: 1,
          syncCursor: over.syncCursor === undefined ? '1000' : over.syncCursor,
          watchExpiresAt: over.watchExpiresAt ?? null,
        },
      });
    });

    await prisma.providerAccountRoute.create({
      data: {
        provider: 'gmail',
        providerAddress: address,
        userId,
        accountId,
        watchExpiresAt: over.watchExpiresAt ?? null,
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    watches = new WatchRepository(service as never);

    for (const id of [alice, bob]) {
      await prisma.user.create({
        data: { id, email: `${id.slice(0, 8)}@example.com`, status: 'active' },
      });
    }
  });

  beforeEach(async () => {
    await prisma.providerAccountRoute.deleteMany({
      where: { accountId: { in: [aliceAccount, bobAccount] } },
    });
    for (const [userId, accountId] of [
      [alice, aliceAccount],
      [bob, bobAccount],
    ] as const) {
      await withTenant(userId, async (tx) => {
        await tx.emailAccount.deleteMany({ where: { id: accountId } });
      });
    }
  });

  afterAll(async () => {
    await prisma.providerAccountRoute.deleteMany({
      where: { accountId: { in: [aliceAccount, bobAccount] } },
    });
    for (const [userId, accountId] of [
      [alice, aliceAccount],
      [bob, bobAccount],
    ] as const) {
      await withTenant(userId, async (tx) => {
        await tx.emailAccount.deleteMany({ where: { id: accountId } });
      }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await prisma.$disconnect();
  });

  /** Restricts a result to the accounts this spec created; the table is shared. */
  const mine = <T extends { accountId: string }>(rows: T[]) =>
    rows.filter((r) => r.accountId === aliceAccount || r.accountId === bobAccount);

  describe('finding what is due', () => {
    it('sees mailboxes belonging to different users', async () => {
      // The sweep has no tenant. If this returns one row, or none, the whole
      // renewal path silently stops working for everyone but the last user.
      await seedAccount(alice, aliceAccount, { watchExpiresAt: new Date(Date.now() + HOUR) });
      await seedAccount(bob, bobAccount, { watchExpiresAt: new Date(Date.now() + 2 * HOUR) });

      const due = mine(await watches.findDue(48, 100));

      expect(due.map((d) => d.accountId).sort()).toEqual([aliceAccount, bobAccount].sort());
      expect(due.find((d) => d.accountId === aliceAccount)?.userId).toBe(alice);
      expect(due.find((d) => d.accountId === bobAccount)?.userId).toBe(bob);
    });

    it('puts mailboxes with no watch first', async () => {
      // Those are receiving nothing right now. A mailbox that still has a day
      // left is in better shape.
      await seedAccount(alice, aliceAccount, { watchExpiresAt: new Date(Date.now() + HOUR) });
      await seedAccount(bob, bobAccount, { watchExpiresAt: null });

      const due = mine(await watches.findDue(48, 100));

      expect(due[0]!.accountId).toBe(bobAccount);
      expect(due[0]!.expiresAt).toBeNull();
    });

    it('leaves a healthy watch alone', async () => {
      await seedAccount(alice, aliceAccount, {
        watchExpiresAt: new Date(Date.now() + 6 * 24 * HOUR),
      });

      expect(mine(await watches.findDue(48, 100))).toHaveLength(0);
    });

    it('includes one that has already lapsed', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: new Date(Date.now() - HOUR) });

      expect(mine(await watches.findDue(48, 100))).toHaveLength(1);
    });

    it('respects the batch cap', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null });
      await seedAccount(bob, bobAccount, { watchExpiresAt: null });

      expect(await watches.findDue(48, 1)).toHaveLength(1);
    });
  });

  describe('recording a renewal', () => {
    it('writes the new expiry to both the account and its route', async () => {
      // They are a source of truth and an index into it. A route that reads
      // healthier than its account is a mailbox that goes quiet in seven days
      // with nothing to show for it.
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null });
      const expiresAt = new Date(Date.now() + 7 * 24 * HOUR);

      await watches.recordRenewed(alice, aliceAccount, expiresAt, '5000');

      const account = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: aliceAccount } }),
      );
      const route = await prisma.providerAccountRoute.findFirst({
        where: { accountId: aliceAccount },
      });

      expect(account!.watchExpiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(route!.watchExpiresAt?.getTime()).toBe(expiresAt.getTime());
    });

    it('does not overwrite an existing sync cursor', async () => {
      // Gmail hands back its current historyId on renewal. Storing it would
      // skip every message between the stored position and now — mail the user
      // never hears about, which is the exact failure this sweep exists to
      // prevent.
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null, syncCursor: '1000' });

      await watches.recordRenewed(alice, aliceAccount, new Date(Date.now() + HOUR), '999999');

      const account = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: aliceAccount } }),
      );
      expect(account!.syncCursor).toBe('1000');
    });

    it('adopts the cursor when the account has none', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null, syncCursor: null });

      await watches.recordRenewed(alice, aliceAccount, new Date(Date.now() + HOUR), '999999');

      const account = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: aliceAccount } }),
      );
      expect(account!.syncCursor).toBe('999999');
    });

    it('takes the account off the polling fallback', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null });
      await withTenant(alice, (tx) =>
        tx.emailAccount.update({
          where: { id: aliceAccount },
          data: { pollingSince: new Date(), consecutiveFailures: 3 },
        }),
      );

      await watches.recordRenewed(alice, aliceAccount, new Date(Date.now() + HOUR), '1');

      const account = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: aliceAccount } }),
      );
      expect(account!.pollingSince).toBeNull();
      expect(account!.consecutiveFailures).toBe(0);
    });
  });

  describe('recording a failure', () => {
    it('clears both expiries and marks polling when no watch could be made', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: new Date(Date.now() + HOUR) });

      await watches.recordUnavailable(alice, aliceAccount, 'DEPENDENCY_UNAVAILABLE');

      const account = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: aliceAccount } }),
      );
      const route = await prisma.providerAccountRoute.findFirst({
        where: { accountId: aliceAccount },
      });

      expect(account!.watchExpiresAt).toBeNull();
      expect(account!.pollingSince).not.toBeNull();
      expect(route!.watchExpiresAt).toBeNull();
      // And so the next sweep sees it first rather than treating it as healthy.
      expect(mine(await watches.findDue(48, 100))[0]!.accountId).toBe(aliceAccount);
    });

    it('leaves the expiry alone for a failure worth retrying', async () => {
      const expiresAt = new Date(Date.now() + HOUR);
      await seedAccount(alice, aliceAccount, { watchExpiresAt: expiresAt });

      await watches.recordRenewalFailure(alice, aliceAccount, 'PROVIDER_RATE_LIMITED');

      const account = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: aliceAccount } }),
      );
      const route = await prisma.providerAccountRoute.findFirst({
        where: { accountId: aliceAccount },
      });

      expect(account!.watchExpiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(route!.watchExpiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(account!.consecutiveFailures).toBe(1);
      expect(account!.lastErrorCode).toBe('PROVIDER_RATE_LIMITED');
    });
  });

  it('drops the route for an unreachable mailbox', async () => {
    await seedAccount(alice, aliceAccount, { watchExpiresAt: null });

    await watches.dropRoute(aliceAccount);

    expect(
      await prisma.providerAccountRoute.findFirst({ where: { accountId: aliceAccount } }),
    ).toBeNull();
    expect(mine(await watches.findDue(48, 100))).toHaveLength(0);
  });

  describe('what the sweep still cannot do', () => {
    it('cannot read another user’s mailbox even knowing its id', async () => {
      // The route hands out a (userId, accountId) pair and nothing else. This is
      // the property that made mirroring the expiry onto an unprotected table
      // an acceptable trade in the first place.
      await seedAccount(bob, bobAccount, { watchExpiresAt: null });

      const seen = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: bobAccount } }),
      );

      expect(seen).toBeNull();
    });

    it('cannot renew another user’s watch by naming their account', async () => {
      const expiresAt = new Date(Date.now() + 6 * 24 * HOUR);
      await seedAccount(bob, bobAccount, { watchExpiresAt: expiresAt });

      // Alice's tenant context, Bob's account id. RLS makes the update match no
      // rows; Prisma reports that as a failed update.
      await expect(
        watches.recordRenewed(alice, bobAccount, new Date(Date.now() + HOUR), '1'),
      ).rejects.toThrow();

      const account = await withTenant(bob, (tx) =>
        tx.emailAccount.findUnique({ where: { id: bobAccount } }),
      );
      expect(account!.watchExpiresAt?.getTime()).toBe(expiresAt.getTime());
    });
  });

  describe('the polling fallback', () => {
    const mineOf = <T extends { accountId: string }>(rows: T[]) =>
      rows.filter((r) => r.accountId === aliceAccount || r.accountId === bobAccount);

    it('finds a mailbox with no watch, across tenants', async () => {
      // The route table already knows: a null expiry is written when a watch
      // could not be established, so no extra state is needed to answer this.
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null });
      await seedAccount(bob, bobAccount, { watchExpiresAt: null });

      const unwatched = mineOf(await watches.findWithoutWatch(100));

      expect(unwatched.map((u) => u.accountId).sort()).toEqual([aliceAccount, bobAccount].sort());
    });

    it('ignores a mailbox that is on push', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: new Date(Date.now() + HOUR) });

      expect(mineOf(await watches.findWithoutWatch(100))).toHaveLength(0);
    });

    it('stops on its own once a watch is established', async () => {
      // Self-limiting: recording a renewal sets the expiry, which is the same
      // column this query filters on.
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null });
      expect(mineOf(await watches.findWithoutWatch(100))).toHaveLength(1);

      await watches.recordRenewed(alice, aliceAccount, new Date(Date.now() + 7 * 24 * HOUR), '1');

      expect(mineOf(await watches.findWithoutWatch(100))).toHaveLength(0);
    });

    it('starts again when a watch is lost', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: new Date(Date.now() + HOUR) });
      expect(mineOf(await watches.findWithoutWatch(100))).toHaveLength(0);

      await watches.recordUnavailable(alice, aliceAccount, 'DEPENDENCY_UNAVAILABLE');

      expect(mineOf(await watches.findWithoutWatch(100))).toHaveLength(1);
    });

    it('respects the batch cap', async () => {
      await seedAccount(alice, aliceAccount, { watchExpiresAt: null });
      await seedAccount(bob, bobAccount, { watchExpiresAt: null });

      expect(await watches.findWithoutWatch(1)).toHaveLength(1);
    });
  });
});
