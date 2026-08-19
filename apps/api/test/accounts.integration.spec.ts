import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { EnvelopeEncryption, LocalKmsProvider } from '@wea/crypto';
import { AccountsService } from '../src/accounts/accounts.service.js';

/**
 * Listing and disconnecting mailboxes, against real rows.
 *
 * Two things could not be usefully faked. The tenant boundary — an `accountId`
 * in a URL is a value an attacker chooses, so "belongs to someone else" has to
 * resolve to nothing rather than to their mailbox, and that is row-level
 * security doing it rather than a `where` clause anyone could forget. And the
 * shape of a disconnect: the row is *marked*, not deleted, because deleting it
 * cascades away the delivery records that resolve a user's outstanding WhatsApp
 * replies.
 *
 * `TEST_DATABASE_URL` must use the restricted `wea_app` role, or the isolation
 * assertions pass without proving anything.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('connected mailboxes (real database)', () => {
  let prisma: PrismaClient;
  let service: AccountsService;
  let stopWatch: ReturnType<typeof vi.fn>;

  const alice = randomUUID();
  const bob = randomUUID();
  const accounts: Record<string, string> = { [alice]: randomUUID(), [bob]: randomUUID() };

  const withTenant = <T>(id: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, id, fn as never) as Promise<T>;

  // A real key and real ciphertext. The token has to actually decrypt, because
  // `stopWatching` decrypts before it reaches the provider — and it swallows
  // every failure, so a fixture with junk bytes would make the assertion that
  // the subscription is cancelled pass vacuously.
  const masterKey = randomBytes(32).toString('base64');
  const crypto = new EnvelopeEncryption(LocalKmsProvider.fromBase64(masterKey));

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });

    const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role!.rolsuper || role!.rolbypassrls, 'test role bypasses RLS').toBe(false);

    const client = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });

    service = new AccountsService(
      client as never,
      { env: { KMS_PROVIDER: 'local', ENCRYPTION_MASTER_KEY: masterKey } } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    );

    // The one stub: cancelling a push subscription is an HTTP call to Google or
    // Microsoft. What matters is that a failure here does not fail the
    // disconnect, which is asserted below by making it throw.
    stopWatch = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { providerFor: () => unknown }).providerFor = () => ({ stopWatch });

    for (const userId of [alice, bob]) {
      await prisma.user.create({
        data: { id: userId, email: `${userId.slice(0, 8)}@example.com`, status: 'active' },
      });
    }
  });

  beforeEach(async () => {
    stopWatch.mockClear();
    stopWatch.mockResolvedValue(undefined);

    for (const [userId, accountId] of Object.entries(accounts)) {
      const sealed = await crypto.encryptString('provider-access-token', {
        userId,
        field: 'accessToken',
      });

      await withTenant(userId, async (tx) => {
        await tx.emailAccount.deleteMany({ where: { userId } });
        await tx.emailAccount.create({
          data: {
            id: accountId,
            userId,
            provider: 'gmail',
            emailAddress: `${userId.slice(0, 8)}@example.com`,
            status: 'active',
            providerAccountId: `acct-${userId.slice(0, 8)}`,
            accessTokenCipher: new Uint8Array(sealed.ciphertext),
            accessTokenDek: new Uint8Array(sealed.wrappedKey),
            refreshTokenCipher: new Uint8Array(sealed.ciphertext),
            refreshTokenDek: new Uint8Array(sealed.wrappedKey),
            tokenKeyVersion: sealed.keyVersion,
            isPrimary: true,
            watchSubscriptionId: 'sub-1',
          },
        });
      });
      await prisma.providerAccountRoute.upsert({
        where: {
          provider_providerAddress: {
            provider: 'gmail',
            providerAddress: `${userId.slice(0, 8)}@example.com`,
          },
        },
        create: {
          provider: 'gmail',
          providerAddress: `${userId.slice(0, 8)}@example.com`,
          userId,
          accountId,
        },
        update: { userId, accountId },
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await prisma.$disconnect();
  });

  describe('listing', () => {
    it('returns this user’s mailboxes and nobody else’s', async () => {
      const listed = await service.list(alice);

      expect(listed.map((a) => a.id)).toEqual([accounts[alice]]);
    });

    it('carries nothing a UI has no use for', async () => {
      // A mailbox list is not a place to leak the shape of our sync state.
      const [account] = await service.list(alice);
      const serialized = JSON.stringify(account);

      for (const leaked of ['accessToken', 'refreshToken', 'syncCursor', 'watchSubscriptionId']) {
        expect(serialized).not.toContain(leaked);
      }
    });

    it('reports a healthy mailbox as healthy', async () => {
      const [account] = await service.list(alice);
      expect(account!.health).toEqual({ state: 'healthy' });
    });

    it('reports a polling mailbox as degraded rather than broken', async () => {
      // Mail still arrives, a couple of minutes later. Worth showing, not worth
      // alarming about — and a different message from "reconnect".
      await withTenant(alice, async (tx) => {
        await tx.emailAccount.update({
          where: { id: accounts[alice]! },
          data: { pollingSince: new Date() },
        });
      });

      const [account] = await service.list(alice);
      expect(account!.health).toEqual({ state: 'degraded', reason: 'polling' });
    });

    it('reports a lapsed grant as something the user must act on', async () => {
      await withTenant(alice, async (tx) => {
        await tx.emailAccount.update({
          where: { id: accounts[alice]! },
          data: { status: 'reauth_required', lastErrorCode: 'PROVIDER_UNAUTHORIZED' },
        });
      });

      const [account] = await service.list(alice);
      expect(account!.health).toMatchObject({ state: 'reconnect' });
    });

    it('omits mailboxes that were already disconnected', async () => {
      await service.disconnect(alice, accounts[alice]!);

      expect(await service.list(alice)).toEqual([]);
    });
  });

  describe('disconnecting', () => {
    it('marks the row rather than deleting it', async () => {
      // Deleting cascades away the delivery records that resolve a user's
      // outstanding WhatsApp replies — every pending notification would become a
      // reply that resolves to nothing.
      await service.disconnect(alice, accounts[alice]!);

      const row = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: accounts[alice]! } }),
      );

      expect(row).not.toBeNull();
      expect(row!.status).toBe('disconnected');
      expect(row!.disconnectedAt).not.toBeNull();
    });

    it('gives up the tokens, which is the difference from a pause', async () => {
      await service.disconnect(alice, accounts[alice]!);

      const row = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: accounts[alice]! } }),
      );

      expect(row!.refreshTokenCipher).toBeNull();
      expect(Buffer.from(row!.accessTokenCipher).length).toBe(0);
    });

    it('drops the route, so inbound pushes stop immediately', async () => {
      await service.disconnect(alice, accounts[alice]!);

      const routes = await prisma.providerAccountRoute.findMany({
        where: { accountId: accounts[alice]! },
      });
      expect(routes).toEqual([]);
    });

    it('cancels the push subscription, carrying the id Graph renews by', async () => {
      await service.disconnect(alice, accounts[alice]!);

      expect(stopWatch).toHaveBeenCalledWith(
        expect.objectContaining({ config: { subscriptionId: 'sub-1' } }),
      );
    });

    it('disconnects anyway when the provider refuses', async () => {
      // A revoked grant cannot cancel anything, which is exactly the case where
      // someone is most likely to be disconnecting. Both providers expire their
      // subscriptions within days regardless.
      stopWatch.mockRejectedValue(new Error('grant revoked'));

      await expect(service.disconnect(alice, accounts[alice]!)).resolves.toBeUndefined();

      const row = await withTenant(alice, (tx) =>
        tx.emailAccount.findUnique({ where: { id: accounts[alice]! } }),
      );
      expect(row!.status).toBe('disconnected');
    });

    it('refuses to disconnect the same mailbox twice', async () => {
      await service.disconnect(alice, accounts[alice]!);

      await expect(service.disconnect(alice, accounts[alice]!)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('cannot reach another user’s mailbox, even with its real id', async () => {
      // The id in a URL is a value an attacker chooses. Row-level security is
      // what makes a guessed one resolve to nothing.
      await expect(service.disconnect(alice, accounts[bob]!)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const bobsRow = await withTenant(bob, (tx) =>
        tx.emailAccount.findUnique({ where: { id: accounts[bob]! } }),
      );
      expect(bobsRow!.status).toBe('active');
      expect(bobsRow!.disconnectedAt).toBeNull();
    });

    it('does not drop another user’s route while failing', async () => {
      await service.disconnect(alice, accounts[bob]!).catch(() => undefined);

      const routes = await prisma.providerAccountRoute.findMany({
        where: { accountId: accounts[bob]! },
      });
      expect(routes).toHaveLength(1);
    });
  });
});
