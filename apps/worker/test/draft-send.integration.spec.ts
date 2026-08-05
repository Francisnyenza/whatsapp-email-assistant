import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { DraftRepository } from '../src/repositories/draft.repository.js';
import { composeReplyFrom } from '../src/processors/send.processor.js';

/**
 * The at-most-once guarantee, against a real database.
 *
 * A duplicate email is the failure a user notices most and can least undo. The
 * guard is a conditional write rather than an in-process check, so it has to be
 * tested where the race actually happens — two concurrent claims against
 * Postgres, not two calls to a mock.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('draft sending (real database)', () => {
  let prisma: PrismaClient;
  let drafts: DraftRepository;

  const userId = randomUUID();
  const accountId = randomUUID();
  const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  let originalId: string;

  const withTenant = <T>(id: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, id, fn as never) as Promise<T>;

  const cipher = () => new Uint8Array([1, 2, 3, 4]);

  const newDraft = () =>
    drafts.createForSend({
      userId,
      accountId,
      inReplyToMessageId: originalId,
      to: [{ address: 'sarah.chen@acme.com' }],
      subject: 'Re: Q3 report',
      bodyText: 'On it.',
      bodyCipher: cipher() as never,
      bodyDek: cipher() as never,
      bodyKeyVersion: 1,
      inReplyTo: '<parent@acme.com>',
      references: ['<root@acme.com>', '<parent@acme.com>'],
      providerThreadId: 'thread-abc',
    });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    drafts = new DraftRepository(service as never);

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        status: 'active',
        phoneNumber: phone,
      },
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
          accessTokenCipher: cipher(),
          accessTokenDek: cipher(),
          tokenKeyVersion: 1,
        },
      });

      const threadId = randomUUID();
      originalId = randomUUID();

      await tx.emailThread.create({
        data: {
          id: threadId,
          userId,
          accountId,
          providerThreadId: 'thread-abc',
          subject: 'Q3 report',
          lastMessageAt: new Date(),
        },
      });
      await tx.emailMessage.create({
        data: {
          id: originalId,
          userId,
          accountId,
          threadId,
          providerMessageId: `msg-${originalId.slice(0, 8)}`,
          messageIdHeader: '<parent@acme.com>',
          references: ['<root@acme.com>'],
          subject: 'Q3 report',
          fromAddress: 'sarah.chen@acme.com',
          fromName: 'Sarah Chen',
          toAddresses: [`${userId.slice(0, 8)}@example.com`],
          sentAt: new Date(),
          receivedAt: new Date(),
          snippet: 'Q3 report',
          contentHash: originalId,
        },
      });

      await tx.conversationState.create({
        data: { userId, lastInboundAt: new Date(), expiresAt: new Date(Date.now() + 600_000) },
      });
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('freezes the threading headers at compose time', async () => {
    // Recomputing them at send time risks drift if the thread moved on, which
    // detaches the reply from its own conversation.
    const { id } = await newDraft();

    const stored = await withTenant(userId, (tx) => tx.draft.findUnique({ where: { id } }));
    expect(stored?.inReplyToHeader).toBe('<parent@acme.com>');
    expect(stored?.referencesHeader).toEqual(['<root@acme.com>', '<parent@acme.com>']);
  });

  it('claims a queued draft and hands back everything the send needs', async () => {
    const { id } = await newDraft();
    const claimed = await drafts.claimForSending(userId, id);

    expect(claimed).not.toBeNull();
    expect(claimed!.to).toEqual([{ address: 'sarah.chen@acme.com' }]);
    expect(claimed!.inReplyTo).toBe('<parent@acme.com>');
    expect(claimed!.providerThreadId).toBe('thread-abc');
    expect(claimed!.phoneNumber).toBe(phone);
    expect(claimed!.lastInboundAt).not.toBeNull();
  });

  it('lets exactly one of two concurrent claims win', async () => {
    // The race this guard exists for: two workers, one draft.
    const { id } = await newDraft();

    const [a, b] = await Promise.all([
      drafts.claimForSending(userId, id),
      drafts.claimForSending(userId, id),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('refuses to re-claim a draft already sent', async () => {
    const { id } = await newDraft();
    await drafts.claimForSending(userId, id);
    await drafts.markSent(userId, id, 'gmail-msg-1');

    expect(await drafts.claimForSending(userId, id)).toBeNull();
  });

  it('returns a retryable failure to the queue so the next attempt can claim it', async () => {
    const { id } = await newDraft();
    await drafts.claimForSending(userId, id);
    await drafts.markFailed(userId, id, 'Gmail was unreachable', true);

    expect(await drafts.claimForSending(userId, id)).not.toBeNull();
  });

  it('leaves a permanent failure unclaimable', async () => {
    // Returning it to the queue would have it retried forever against an error
    // that will not change.
    const { id } = await newDraft();
    await drafts.claimForSending(userId, id);
    await drafts.markFailed(userId, id, 'Mailbox disconnected', false);

    expect(await drafts.claimForSending(userId, id)).toBeNull();

    const stored = await withTenant(userId, (tx) => tx.draft.findUnique({ where: { id } }));
    expect(stored?.status).toBe('failed');
    expect(stored?.failureReason).toBe('Mailbox disconnected');
  });

  it('gives every draft its own idempotency key', async () => {
    const keys = await Promise.all([newDraft(), newDraft(), newDraft()]);
    expect(new Set(keys.map((k) => k.idempotencyKey)).size).toBe(3);
  });

  it('records the provider id on a successful send, for the audit trail', async () => {
    const { id } = await newDraft();
    await drafts.claimForSending(userId, id);
    await drafts.markSent(userId, id, 'gmail-msg-99');

    const stored = await withTenant(userId, (tx) => tx.draft.findUnique({ where: { id } }));
    expect(stored?.status).toBe('sent');
    expect(stored?.sentProviderMessageId).toBe('gmail-msg-99');
    expect(stored?.sentAt).not.toBeNull();
  });

  it('loads the original message with what threading needs', async () => {
    const original = await drafts.findOriginal(userId, originalId);

    expect(original?.messageIdHeader).toBe('<parent@acme.com>');
    expect(original?.references).toEqual(['<root@acme.com>']);
    expect(original?.thread.providerThreadId).toBe('thread-abc');
  });

  it('composes reply headers that thread onto the original', async () => {
    const original = await drafts.findOriginal(userId, originalId);

    const composed = composeReplyFrom(
      {
        messageIdHeader: original!.messageIdHeader,
        references: original!.references,
        subject: original!.subject,
        from: {
          address: original!.fromAddress,
          ...(original!.fromName ? { name: original!.fromName } : {}),
        },
        to: original!.toAddresses.map((address) => ({ address })),
        cc: original!.ccAddresses.map((address) => ({ address })),
      },
      `${userId.slice(0, 8)}@example.com`,
      false,
    );

    expect(composed.subject).toBe('Re: Q3 report');
    expect(composed.inReplyTo).toBe('<parent@acme.com>');
    // The parent must be last — that is what places the reply in the thread.
    expect(composed.references.at(-1)).toBe('<parent@acme.com>');
    expect(composed.to).toEqual([{ name: 'Sarah Chen', address: 'sarah.chen@acme.com' }]);
  });
});
