import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { SearchRepository, vectorLiteral } from '../src/repositories/search.repository.js';

/**
 * Hybrid search, against a real Postgres with pgvector and pg_trgm.
 *
 * Nothing in this file could be usefully faked. The whole feature *is* the SQL:
 * an HNSW index, a `tsquery`, a trigram threshold and a reciprocal-rank fusion
 * that only exists as a query plan. A stub that returned rows in a plausible
 * order would prove the calling code compiles and nothing else — which is
 * precisely the failure this project has already been bitten by once, when a
 * fetch stub honoured a signature and ignored the contract.
 *
 * `TEST_DATABASE_URL` must use the restricted `wea_app` role, or the isolation
 * assertion below passes without proving anything.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

const DIMS = 1536;

/**
 * A deterministic unit vector pointing mostly along one axis. Two vectors built
 * from nearby axes are close; distant axes are far. That is enough structure to
 * assert on ordering without shipping a real embedding into the repository.
 */
function vectorOn(axis: number): number[] {
  const v = Array.from({ length: DIMS }, () => 0.001);
  v[axis % DIMS] = 1;
  return v;
}

describeIfDb('mailbox search (real database)', () => {
  let prisma: PrismaClient;
  let search: SearchRepository;

  const alice = randomUUID();
  const bob = randomUUID();
  const accounts: Record<string, string> = { [alice]: randomUUID(), [bob]: randomUUID() };

  const withTenant = <T>(id: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, id, fn as never) as Promise<T>;

  async function seed(
    userId: string,
    input: {
      subject: string;
      snippet: string;
      fromAddress?: string;
      fromName?: string;
      ageHours?: number;
      deleted?: boolean;
      unread?: boolean;
      priority?: 'urgent' | 'high' | 'normal' | 'low';
    },
  ): Promise<string> {
    const id = randomUUID();
    const threadId = randomUUID();
    const receivedAt = new Date(Date.now() - (input.ageHours ?? 1) * 3_600_000);

    await withTenant(userId, async (tx) => {
      await tx.emailThread.create({
        data: {
          id: threadId,
          userId,
          accountId: accounts[userId]!,
          providerThreadId: `thr-${id.slice(0, 8)}`,
          subject: input.subject,
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
          subject: input.subject,
          fromAddress: input.fromAddress ?? 'sarah@acme.com',
          ...(input.fromName ? { fromName: input.fromName } : {}),
          toAddresses: ['me@example.com'],
          sentAt: receivedAt,
          receivedAt,
          snippet: input.snippet,
          contentHash: id,
          isUnread: input.unread ?? true,
          ...(input.deleted ? { deletedAt: new Date() } : {}),
        },
      });

      if (input.priority) {
        await tx.messageAnalysis.create({
          data: {
            userId,
            emailMessageId: id,
            summary: input.subject,
            bulletSummary: [],
            category: 'work',
            priority: input.priority,
            urgencyScore: 0.5,
            spamScore: 0,
            language: 'en',
            sentiment: 'neutral',
            requiresReply: false,
            entities: [],
            actionItems: [],
            suggestedReplies: [],
            modelProvider: 'test',
            model: 'test',
            tokensUsed: 0,
          },
        });
      }
    });

    return id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });

    // The same guard the application makes at boot. Without it every isolation
    // assertion in this file is vacuously true.
    const [role] = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role, 'could not read the current role').toBeDefined();
    expect(role!.rolsuper || role!.rolbypassrls, 'test role bypasses RLS').toBe(false);

    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    search = new SearchRepository(service as never);

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
        await tx.messageAnalysis.deleteMany({ where: { userId } });
        await tx.emailMessage.deleteMany({ where: { userId } });
        await tx.emailThread.deleteMany({ where: { userId } });
      });
    }
    // A completed backfill is the one piece of state that outlives a message,
    // so it is reset here rather than leaking into the next test.
    await prisma.user.updateMany({
      where: { id: { in: [alice, bob] } },
      data: { embeddingBackfilledAt: null },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
    await prisma.$disconnect();
  });

  /* ------------------------------ keyword ------------------------------- */

  describe('keyword search', () => {
    it('finds an email by a word in its subject', async () => {
      const id = await seed(alice, { subject: 'Invoice 4471 attached', snippet: 'Payment due' });
      await seed(alice, { subject: 'Lunch on Thursday', snippet: 'Are you free' });

      const hits = await search.search(alice, 'invoice');

      expect(hits.map((h) => h.emailMessageId)).toEqual([id]);
    });

    it('finds an email by a word in its snippet', async () => {
      const id = await seed(alice, {
        subject: 'Following up',
        snippet: 'the contract renewal is due next week',
      });

      const hits = await search.search(alice, 'contract');

      expect(hits.map((h) => h.emailMessageId)).toContain(id);
    });

    it('survives a misspelled sender name', async () => {
      // Trigram similarity is the whole point of the third arm: nobody types a
      // name the way it is stored.
      const id = await seed(alice, {
        subject: 'Quarterly numbers',
        snippet: 'attached',
        fromName: 'Sarah Chen',
      });

      const hits = await search.search(alice, 'Sara Chen');

      expect(hits.map((h) => h.emailMessageId)).toContain(id);
    });

    it('matches a sender address', async () => {
      const id = await seed(alice, {
        subject: 'Deployment window',
        snippet: 'Friday night',
        fromAddress: 'ops@vendor.io',
      });

      const hits = await search.search(alice, 'vendor.io');

      expect(hits.map((h) => h.emailMessageId)).toContain(id);
    });

    it('returns nothing rather than everything for a query that matches nothing', async () => {
      await seed(alice, { subject: 'Invoice 4471', snippet: 'Payment due' });

      expect(await search.search(alice, 'zzzznonexistent')).toEqual([]);
    });

    it('treats an empty query as no query', async () => {
      await seed(alice, { subject: 'Invoice 4471', snippet: 'Payment due' });

      expect(await search.search(alice, '   ')).toEqual([]);
    });

    it('does not return trashed mail', async () => {
      // Offering someone an email they just deleted is how "did that work?"
      // starts.
      await seed(alice, { subject: 'Invoice 4471', snippet: 'Payment due', deleted: true });

      expect(await search.search(alice, 'invoice')).toEqual([]);
    });
  });

  /* ------------------------------ semantic ------------------------------- */

  describe('semantic search', () => {
    it('ranks the nearest vector first, even with no keyword overlap', async () => {
      const near = await seed(alice, { subject: 'Booking reference QX21', snippet: 'confirmed' });
      const far = await seed(alice, { subject: 'Parking permit', snippet: 'renewed' });

      await search.saveEmbedding(alice, near, vectorOn(7), 'test-model');
      await search.saveEmbedding(alice, far, vectorOn(900), 'test-model');

      const hits = await search.search(alice, 'where am I staying', { vector: vectorOn(7) });

      expect(hits[0]?.emailMessageId).toBe(near);
      expect(hits.map((h) => h.emailMessageId)).toContain(far);
    });

    it('fuses with the keyword arm rather than replacing it', async () => {
      // An email that only the keyword arm can find must still come back when a
      // vector is supplied — that is the difference between hybrid and a vector
      // search with extra steps.
      const lexicalOnly = await seed(alice, {
        subject: 'Invoice 4471 attached',
        snippet: 'Payment due',
      });
      const semanticOnly = await seed(alice, { subject: 'Parking permit', snippet: 'renewed' });
      await search.saveEmbedding(alice, semanticOnly, vectorOn(3), 'test-model');

      const hits = await search.search(alice, 'invoice', { vector: vectorOn(3) });
      const ids = hits.map((h) => h.emailMessageId);

      expect(ids).toContain(lexicalOnly);
      expect(ids).toContain(semanticOnly);
    });

    it('ranks a message both arms agree on above one only a single arm found', async () => {
      const both = await seed(alice, { subject: 'Invoice 4471 attached', snippet: 'Payment due' });
      const semanticOnly = await seed(alice, { subject: 'Parking permit', snippet: 'renewed' });

      await search.saveEmbedding(alice, both, vectorOn(5), 'test-model');
      await search.saveEmbedding(alice, semanticOnly, vectorOn(6), 'test-model');

      const hits = await search.search(alice, 'invoice', { vector: vectorOn(5) });

      expect(hits[0]?.emailMessageId).toBe(both);
    });

    it('still works with no vector at all, which is an ordinary deployment', async () => {
      const id = await seed(alice, { subject: 'Invoice 4471', snippet: 'Payment due' });

      const hits = await search.search(alice, 'invoice');

      expect(hits.map((h) => h.emailMessageId)).toEqual([id]);
    });

    it('overwrites rather than duplicating when a message is re-embedded', async () => {
      const id = await seed(alice, { subject: 'Booking reference', snippet: 'confirmed' });

      await search.saveEmbedding(alice, id, vectorOn(10), 'old-model');
      await search.saveEmbedding(alice, id, vectorOn(11), 'new-model');

      const rows = await withTenant(
        alice,
        (tx) =>
          tx.$queryRaw<Array<{ model: string }>>`
          SELECT model FROM message_embeddings WHERE email_message_id = ${id}::uuid
        `,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe('new-model');
    });

    it('reports whether a message has been embedded, so a retry does not re-bill', async () => {
      const id = await seed(alice, { subject: 'Booking reference', snippet: 'confirmed' });

      expect(await search.hasEmbedding(alice, id)).toBe(false);
      await search.saveEmbedding(alice, id, vectorOn(12), 'test-model');
      expect(await search.hasEmbedding(alice, id)).toBe(true);
    });
  });

  /* ------------------------------ isolation ------------------------------ */

  describe('tenant isolation', () => {
    it('never returns another user’s mail, on either arm', async () => {
      const bobs = await seed(bob, { subject: 'Invoice 4471 attached', snippet: 'Payment due' });
      await search.saveEmbedding(bob, bobs, vectorOn(20), 'test-model');

      const hits = await search.search(alice, 'invoice', { vector: vectorOn(20) });

      expect(hits).toEqual([]);
    });

    it('cannot read another user’s embedding through hasEmbedding', async () => {
      const bobs = await seed(bob, { subject: 'Invoice 4471', snippet: 'Payment due' });
      await search.saveEmbedding(bob, bobs, vectorOn(21), 'test-model');

      expect(await search.hasEmbedding(alice, bobs)).toBe(false);
    });

    it('refuses to write an embedding onto another user’s message', async () => {
      // Not a leak — the read path joins `email_messages` and RLS scopes that.
      // The damage would be the unique constraint on `email_message_id`: Alice's
      // row squats on the one Bob's own job needs. RLS alone does not stop this,
      // because the foreign key is checked by a trigger that runs as the table
      // owner and is exempt from policies. The scoped INSERT ... SELECT does.
      const bobs = await seed(bob, { subject: 'Invoice 4471', snippet: 'Payment due' });

      expect(await search.saveEmbedding(alice, bobs, vectorOn(22), 'test-model')).toBe(false);

      const rows = await prisma.$queryRaw<Array<{ user_id: string }>>`
        SELECT user_id FROM message_embeddings WHERE email_message_id = ${bobs}::uuid
      `;
      expect(rows).toEqual([]);
    });

    it('leaves the real owner able to embed their own message afterwards', async () => {
      // The point of the previous test: a squatted row would break this.
      const bobs = await seed(bob, { subject: 'Invoice 4471', snippet: 'Payment due' });

      await search.saveEmbedding(alice, bobs, vectorOn(23), 'test-model');

      expect(await search.saveEmbedding(bob, bobs, vectorOn(23), 'test-model')).toBe(true);
      expect(await search.hasEmbedding(bob, bobs)).toBe(true);
    });
  });

  /* ------------------------------- backfill ------------------------------ */

  describe('finding what has not been embedded', () => {
    it('returns exactly the messages with no vector', async () => {
      const embedded = await seed(alice, { subject: 'One', snippet: 'a' });
      const bare = await seed(alice, { subject: 'Two', snippet: 'b' });
      await search.saveEmbedding(alice, embedded, vectorOn(30), 'test-model');

      const pending = await search.findUnembedded(alice, 50, new Date(0));

      expect(pending).toEqual([bare]);
    });

    it('empties out as the backfill progresses', async () => {
      // The property that lets the sweep use "returned nothing" as its
      // completion signal, with no cursor to keep.
      const ids = [
        await seed(alice, { subject: 'One', snippet: 'a' }),
        await seed(alice, { subject: 'Two', snippet: 'b' }),
      ];

      expect(await search.findUnembedded(alice, 50, new Date(0))).toHaveLength(2);

      for (const id of ids) await search.saveEmbedding(alice, id, vectorOn(31), 'test-model');

      expect(await search.findUnembedded(alice, 50, new Date(0))).toEqual([]);
    });

    it('respects the window, so an ancient mailbox is not embedded in full', async () => {
      await seed(alice, { subject: 'Ancient', snippet: 'a', ageHours: 24 * 500 });
      const recent = await seed(alice, { subject: 'Recent', snippet: 'b', ageHours: 2 });

      const since = new Date(Date.now() - 365 * 24 * 3_600_000);

      expect(await search.findUnembedded(alice, 50, since)).toEqual([recent]);
    });

    it('skips trashed mail', async () => {
      await seed(alice, { subject: 'Gone', snippet: 'a', deleted: true });

      expect(await search.findUnembedded(alice, 50, new Date(0))).toEqual([]);
    });

    it('is newest first, so an interrupted backfill leaves the useful window done', async () => {
      const older = await seed(alice, { subject: 'Older', snippet: 'a', ageHours: 50 });
      const newer = await seed(alice, { subject: 'Newer', snippet: 'b', ageHours: 2 });

      expect(await search.findUnembedded(alice, 50, new Date(0))).toEqual([newer, older]);
    });

    it('never reaches another tenant’s mail', async () => {
      await seed(bob, { subject: 'Bob’s', snippet: 'private' });

      expect(await search.findUnembedded(alice, 50, new Date(0))).toEqual([]);
    });

    it('enumerates users owed a backfill, and stops listing one that is done', async () => {
      expect(await search.findUsersNeedingBackfill(1000)).toContain(alice);

      await search.markBackfilled(alice);

      expect(await search.findUsersNeedingBackfill(1000)).not.toContain(alice);
      expect(await search.findUsersNeedingBackfill(1000)).toContain(bob);
    });
  });

  /* -------------------------------- lists -------------------------------- */

  describe('the standing lists', () => {
    it('unread excludes what has been read and what has been archived', async () => {
      const unread = await seed(alice, { subject: 'One', snippet: 'a', unread: true });
      await seed(alice, { subject: 'Two', snippet: 'b', unread: false });

      const hits = await search.list(alice, 'unread');

      expect(hits.map((h) => h.emailMessageId)).toEqual([unread]);
    });

    it('today excludes yesterday', async () => {
      const today = await seed(alice, { subject: 'Today', snippet: 'a', ageHours: 0 });
      await seed(alice, { subject: 'Old', snippet: 'b', ageHours: 72 });

      const hits = await search.list(alice, 'today');

      expect(hits.map((h) => h.emailMessageId)).toEqual([today]);
    });

    it('urgent reads the stored analysis and returns nothing without one', async () => {
      await seed(alice, { subject: 'Unanalysed', snippet: 'a' });
      expect(await search.list(alice, 'urgent')).toEqual([]);

      const urgent = await seed(alice, {
        subject: 'Server down',
        snippet: 'b',
        priority: 'urgent',
      });
      expect((await search.list(alice, 'urgent')).map((h) => h.emailMessageId)).toEqual([urgent]);
    });

    it('is newest first', async () => {
      const older = await seed(alice, { subject: 'Older', snippet: 'a', ageHours: 5 });
      const newer = await seed(alice, { subject: 'Newer', snippet: 'b', ageHours: 1 });

      const hits = await search.list(alice, 'unread');

      expect(hits.map((h) => h.emailMessageId)).toEqual([newer, older]);
    });

    it('never crosses a tenant boundary', async () => {
      await seed(bob, { subject: 'Bob’s mail', snippet: 'private' });

      expect(await search.list(alice, 'unread')).toEqual([]);
    });
  });
});

/* --------------------------- the vector literal --------------------------- */

describe('the pgvector literal', () => {
  // These values are interpolated into a string that reaches a typed column.
  // A NaN would be stored as something that silently never matches, and a
  // wrong-length array is a dimension error on a background job nobody watches.

  it('renders a well-formed literal', () => {
    const literal = vectorLiteral(Array.from({ length: DIMS }, () => 0.5));
    expect(literal.startsWith('[0.5,')).toBe(true);
    expect(literal.endsWith(']')).toBe(true);
  });

  it('refuses the wrong number of dimensions', () => {
    expect(() => vectorLiteral([1, 2, 3])).toThrow(/1536 dimensions/);
  });

  it('refuses a non-finite value', () => {
    const bad = Array.from({ length: DIMS }, () => 0.5);
    bad[10] = NaN;
    expect(() => vectorLiteral(bad)).toThrow(/non-finite/);

    bad[10] = Infinity;
    expect(() => vectorLiteral(bad)).toThrow(/non-finite/);
  });

  it('refuses a value that is not a number at all', () => {
    const bad = Array.from({ length: DIMS }, () => 0.5) as unknown[];
    bad[10] = '0.5); DROP TABLE users;--';
    expect(() => vectorLiteral(bad as number[])).toThrow(/non-finite/);
  });
});
