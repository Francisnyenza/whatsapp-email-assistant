import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { DraftRepository } from '../src/repositories/draft.repository.js';
import { StagedAttachmentRepository } from '../src/repositories/staged-attachment.repository.js';

/**
 * Files waiting for the next email, against a real database.
 *
 * Three of the properties this table relies on cannot be tested against a mock,
 * because they are the database's rather than the code's:
 *
 *  * **Claiming is atomic with the draft.** The claim runs inside the
 *    transaction that creates the draft, so a draft cannot exist without its
 *    files and files cannot be spent on a draft that then failed to appear.
 *  * **The unique message id is what stops a redelivered webhook attaching the
 *    same photo twice.** That is a constraint, not an `if`.
 *  * **Row-level security is what makes another tenant's file invisible**, and
 *    the whole point of the second lock is that it holds when the query
 *    forgets its WHERE clause.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('staged attachments (real database)', () => {
  let prisma: PrismaClient;
  let drafts: DraftRepository;
  let staged: StagedAttachmentRepository;

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const accountId = randomUUID();

  const withTenant = <T>(id: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, id, fn as never) as Promise<T>;

  const cipher = () => new Uint8Array([1, 2, 3, 4]);

  const hold = (overrides: Partial<Parameters<StagedAttachmentRepository['stage']>[0]> = {}) =>
    staged.stage({
      userId,
      whatsappMediaId: `media-${randomUUID().slice(0, 8)}`,
      whatsappMessageId: `wamid-${randomUUID()}`,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

  const newDraft = () =>
    drafts.createForSend({
      userId,
      accountId,
      kind: 'new',
      to: [{ address: 'sarah.chen@acme.com' }],
      subject: 'Here it is',
      bodyText: 'Attached.',
      bodyCipher: cipher(),
      bodyDek: cipher(),
      bodyKeyVersion: 1,
    });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    staged = new StagedAttachmentRepository(service as never);
    drafts = new DraftRepository(service as never, staged);

    for (const id of [userId, otherUserId]) {
      await prisma.user.create({
        data: {
          id,
          email: `${id.slice(0, 8)}@example.com`,
          status: 'active',
          phoneNumber: `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
          phoneVerified: true,
        },
      });
    }

    await withTenant(userId, async (tx) => {
      await tx.emailAccount.create({
        data: {
          id: accountId,
          userId,
          provider: 'gmail',
          emailAddress: `${userId.slice(0, 8)}@example.com`,
          status: 'active',
          providerAccountId: `acct-${userId.slice(0, 8)}`,
          accessTokenCipher: cipher(),
          accessTokenDek: cipher(),
          tokenKeyVersion: 1,
        },
      });
    });
  });

  beforeEach(async () => {
    // Per tenant, because the connection this suite uses is the restricted role
    // — an unscoped DELETE matches nothing under row-level security, which is
    // exactly the protection being relied on here.
    for (const id of [userId, otherUserId]) {
      await withTenant(id, async (tx) => {
        await tx.stagedAttachment.deleteMany({});
        await tx.draft.deleteMany({});
      });
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  describe('holding a file', () => {
    it('shows up as pending', async () => {
      await hold();

      const pending = await staged.listPending(userId);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ filename: 'invoice.pdf', sizeBytes: 1024 });
    });

    it('stages a redelivered webhook exactly once', async () => {
      // The unique constraint, not an `if` — two workers can race on the same
      // redelivery, and the second attaching a duplicate photo to the email is
      // the kind of wrong the recipient sees.
      const whatsappMessageId = `wamid-${randomUUID()}`;

      expect(await hold({ whatsappMessageId })).not.toBeNull();
      expect(await hold({ whatsappMessageId })).toBeNull();

      expect(await staged.listPending(userId)).toHaveLength(1);
    });

    it('leaves an expired file out of the pending set', async () => {
      await hold({ expiresAt: new Date(Date.now() - 1000) });

      expect(await staged.listPending(userId)).toHaveLength(0);
    });
  });

  describe('claiming', () => {
    it('attaches the pending set to the draft that is created next', async () => {
      await hold({ filename: 'first.pdf' });
      await hold({ filename: 'second.pdf' });

      const draft = await newDraft();

      expect(draft.attachmentCount).toBe(2);
      expect((await staged.listForDraft(userId, draft.id)).map((f) => f.filename)).toEqual([
        'first.pdf',
        'second.pdf',
      ]);
    });

    it('does not give the same file to a second draft', async () => {
      // Otherwise a photo sent once would go out on every email that followed.
      await hold();

      const first = await newDraft();
      const second = await newDraft();

      expect(first.attachmentCount).toBe(1);
      expect(second.attachmentCount).toBe(0);
      expect(await staged.listForDraft(userId, second.id)).toHaveLength(0);
    });

    it('leaves an expired file behind rather than sending it a day later', async () => {
      await hold({ expiresAt: new Date(Date.now() - 1000) });

      const draft = await newDraft();

      expect(draft.attachmentCount).toBe(0);
    });

    it('empties the pending set, so the next email carries nothing', async () => {
      await hold();
      await newDraft();

      expect(await staged.listPending(userId)).toHaveLength(0);
    });
  });

  describe('dropping', () => {
    it('forgets everything unclaimed', async () => {
      await hold();
      await hold();

      expect(await staged.discardPending(userId)).toBe(2);
      expect(await staged.listPending(userId)).toHaveLength(0);
    });

    it('leaves a file that is already on a draft, because dropping it would not unsend it', async () => {
      await hold();
      const draft = await newDraft();

      expect(await staged.discardPending(userId)).toBe(0);
      expect(await staged.listForDraft(userId, draft.id)).toHaveLength(1);
    });
  });

  describe('tenant isolation', () => {
    it('does not show one user another’s files', async () => {
      await hold();

      expect(await staged.listPending(otherUserId)).toHaveLength(0);
    });

    it('does not let another user’s draft claim them', async () => {
      await hold();

      // The claim is scoped by userId *and* fenced by row-level security, so it
      // matches nothing even though the pending set is non-empty.
      const claimed = await withTenant(otherUserId, (tx) =>
        staged.claimForDraft(tx as never, otherUserId, randomUUID()),
      );

      expect(claimed).toBe(0);
      expect(await staged.listPending(userId)).toHaveLength(1);
    });
  });
});
