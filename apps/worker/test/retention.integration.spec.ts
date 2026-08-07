import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { EnvelopeEncryption, LocalKmsProvider } from '@wea/crypto';
import { RetentionRepository } from '../src/repositories/retention.repository.js';
import { SyncProcessor } from '../src/processors/sync.processor.js';

/**
 * Erasing what we promised not to keep.
 *
 * Storing message bodies is only defensible if they actually go. A purge that
 * silently does nothing turns `RETENTION_BODY_DAYS` into a comment, and the
 * difference is invisible until a breach makes it very visible — so it is
 * checked here against real rows and a real policy.
 *
 * `TEST_DATABASE_URL` must use the restricted `wea_app` role, or the isolation
 * assertion below passes without proving anything.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

const DAY = 24 * 3_600_000;

describeIfDb('retention (real database)', () => {
  let prisma: PrismaClient;
  let retention: RetentionRepository;
  let processor: SyncProcessor;

  const alice = randomUUID();
  const bob = randomUUID();
  const accounts: Record<string, string> = { [alice]: randomUUID(), [bob]: randomUUID() };
  const crypto = new EnvelopeEncryption(new LocalKmsProvider(randomBytes(32)));

  const withTenant = <T>(id: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, id, fn as never) as Promise<T>;

  /** Creates a message with a real sealed body, `ageDays` old. */
  async function seedMessage(userId: string, ageDays: number, withBody = true) {
    const id = randomUUID();
    const threadId = randomUUID();
    const receivedAt = new Date(Date.now() - ageDays * DAY);
    const sealed = await crypto.encryptString(`Body of ${id}`, { userId, field: 'messageBody' });

    await withTenant(userId, async (tx) => {
      await tx.emailThread.create({
        data: {
          id: threadId,
          userId,
          accountId: accounts[userId]!,
          providerThreadId: `thr-${id.slice(0, 8)}`,
          subject: 'Q3 report',
          lastMessageAt: receivedAt,
        },
      });
      await tx.emailMessage.create({
        data: {
          id,
          userId,
          accountId: accounts[userId]!,
          threadId,
          providerMessageId: `msg-${id.slice(0, 8)}`,
          messageIdHeader: `<${id}@acme.com>`,
          subject: 'Q3 report',
          fromAddress: 'sarah@acme.com',
          toAddresses: ['me@example.com'],
          sentAt: receivedAt,
          receivedAt,
          snippet: 'Q3 report',
          contentHash: id,
          ...(withBody
            ? {
                bodyTextCipher: new Uint8Array(sealed.ciphertext),
                bodyDek: new Uint8Array(sealed.wrappedKey),
                bodyKeyVersion: sealed.keyVersion,
              }
            : {}),
        },
      });
    });

    return id;
  }

  const read = (userId: string, id: string) =>
    withTenant(userId, (tx) => tx.emailMessage.findUnique({ where: { id } }));

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    retention = new RetentionRepository(service as never);

    processor = new SyncProcessor(
      { env: { RETENTION_BODY_DAYS: 30, REDIS_URL: 'redis://unused' } } as never,
      {} as never,
      {} as never,
      retention,
      {} as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    );

    for (const [userId, accountId] of Object.entries(accounts)) {
      await prisma.user.create({
        data: { id: userId, email: `${userId.slice(0, 8)}@example.com`, status: 'active' },
      });
      await withTenant(userId, async (tx) => {
        await tx.emailAccount.create({
          data: {
            id: accountId,
            userId,
            provider: 'gmail',
            emailAddress: `${userId.slice(0, 8)}@example.com`,
            status: 'active',
            providerAccountId: `acct-${userId.slice(0, 8)}`,
            accessTokenCipher: new Uint8Array([1]),
            accessTokenDek: new Uint8Array([1]),
            tokenKeyVersion: 1,
          },
        });
      });
    }
  });

  beforeEach(async () => {
    for (const userId of Object.keys(accounts)) {
      await withTenant(userId, async (tx) => {
        await tx.emailMessage.deleteMany({ where: { userId } });
        await tx.emailThread.deleteMany({ where: { userId } });
      });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await prisma.$disconnect();
  });

  describe('what gets erased', () => {
    it('clears a body past the window and records that it did', async () => {
      // Without the timestamp, the interface cannot tell "we never stored this"
      // from "we erased it on schedule", and shows an empty message either way.
      const id = await seedMessage(alice, 60);

      expect(await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100)).toBe(1);

      const message = await read(alice, id);
      expect(message!.bodyTextCipher).toBeNull();
      expect(message!.bodyDek).toBeNull();
      expect(message!.bodyKeyVersion).toBeNull();
      expect(message!.bodyPurgedAt).not.toBeNull();
    });

    it('leaves everything else about the message intact', async () => {
      // The delivery record and the headers are what let a reply still resolve.
      const id = await seedMessage(alice, 60);
      await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100);

      const message = await read(alice, id);
      expect(message!.subject).toBe('Q3 report');
      expect(message!.snippet).toBe('Q3 report');
      expect(message!.messageIdHeader).toContain('@acme.com');
    });

    it('leaves a body inside the window alone', async () => {
      const id = await seedMessage(alice, 5);

      expect(await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100)).toBe(0);
      expect((await read(alice, id))!.bodyTextCipher).not.toBeNull();
    });

    it('does not keep re-purging messages that never had a body', async () => {
      // Otherwise every sweep forever counts the same rows as work done.
      await seedMessage(alice, 60, false);

      expect(await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100)).toBe(0);
    });

    it('is idempotent', async () => {
      await seedMessage(alice, 60);
      await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100);

      expect(await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100)).toBe(0);
    });

    it('respects the per-user row cap', async () => {
      // One enormous mailbox must not hold a transaction open for minutes.
      await seedMessage(alice, 60);
      await seedMessage(alice, 61);
      await seedMessage(alice, 62);

      expect(await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 2)).toBe(2);
    });

    it('takes the oldest first', async () => {
      const oldest = await seedMessage(alice, 90);
      const newer = await seedMessage(alice, 40);

      await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 1);

      expect((await read(alice, oldest))!.bodyTextCipher).toBeNull();
      expect((await read(alice, newer))!.bodyTextCipher).not.toBeNull();
    });
  });

  describe('the sweep across users', () => {
    it('purges every user, not only the first', async () => {
      // The sweep has no tenant. If enumeration returns nothing, bodies are kept
      // forever and nothing anywhere says so.
      const a = await seedMessage(alice, 60);
      const b = await seedMessage(bob, 60);

      await processor.handle({ name: 'sync.purgeExpired', data: {} } as never);

      expect((await read(alice, a))!.bodyPurgedAt).not.toBeNull();
      expect((await read(bob, b))!.bodyPurgedAt).not.toBeNull();
    });

    it('honours the configured window', async () => {
      const recent = await seedMessage(alice, 10);

      await processor.handle({ name: 'sync.purgeExpired', data: {} } as never);

      expect((await read(alice, recent))!.bodyTextCipher).not.toBeNull();
    });
  });

  describe('what the sweep still cannot do', () => {
    it('erases only within the tenant it is scoped to', async () => {
      // Enumeration is cross-tenant; the erasing is not. Passing one user's id
      // must not reach another's mail.
      const mine = await seedMessage(alice, 60);
      const theirs = await seedMessage(bob, 60);

      await retention.purgeBodies(alice, new Date(Date.now() - 30 * DAY), 100);

      expect((await read(alice, mine))!.bodyTextCipher).toBeNull();
      expect((await read(bob, theirs))!.bodyTextCipher).not.toBeNull();
    });

    it('cannot read another user’s body in order to erase it', async () => {
      await seedMessage(bob, 60);

      const seen = await withTenant(alice, (tx) =>
        tx.emailMessage.findMany({ where: { userId: bob } }),
      );

      expect(seen).toHaveLength(0);
    });
  });
});
