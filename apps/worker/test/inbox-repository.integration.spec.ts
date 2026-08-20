import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { InboxRepository } from '../src/repositories/inbox.repository.js';
import { ThreadResolver } from '../src/services/thread-resolver.js';
import type { InboundWhatsAppMessage, WhatsAppStatusUpdate } from '@wea/shared';

/**
 * The resolution ladder against a real database.
 *
 * The unit tests prove the ladder's logic with hand-built candidates. This
 * proves the queries underneath actually return what the ladder expects — that
 * the joins are right, the tenant scoping holds, and a reply really does find
 * its email. `TEST_DATABASE_URL` must use the restricted `wea_app` role, or
 * row-level security is not enforced and the isolation assertions pass
 * vacuously.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('inbox repository (real database)', () => {
  let prisma: PrismaClient;
  let repo: InboxRepository;
  const resolver = new ThreadResolver();

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const accountId = randomUUID();
  const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  const emails: Record<string, string> = {};
  const deliveries: Record<string, string> = {};

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });

    // The repository depends on PrismaService.forUser, which is exactly
    // withTenant bound to the client. Standing it up this way keeps the test
    // exercising the real scoping rather than a permissive stub.
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });
    repo = new InboxRepository(service as never);

    for (const [id, number] of [
      [userId, phone],
      [otherUserId, null],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email: `${id.slice(0, 8)}@example.com`,
          status: 'active',
          timezone: 'Africa/Nairobi',
          // Verified, because these fixtures are users we actually deliver to.
          // An unverified number reads as no number at all — which is the point
          // of the column, and was not true until it started being read.
          ...(number ? { phoneNumber: number, phoneVerified: true } : {}),
        },
      });
    }

    await seedMailbox();
  });

  async function seedMailbox() {
    const fixtures = [
      { key: 'sarah', from: 'sarah.chen@acme.com', name: 'Sarah Chen', subject: 'Q3 report' },
      { key: 'tom', from: 'tom@acme.com', name: 'Tom Riley', subject: 'Standup notes' },
      {
        key: 'billing',
        from: 'billing@vendor.io',
        name: 'Vendor Billing',
        subject: 'Invoice 2291',
      },
    ];

    await withTenant(userId, async (tx) => {
      await tx.emailAccount.create({
        data: {
          id: accountId,
          userId,
          provider: 'gmail',
          emailAddress: `${userId.slice(0, 8)}@example.com`,
          status: 'active',
          providerAccountId: `acct-${userId.slice(0, 8)}`,
          accessTokenCipher: Buffer.from('x'),
          accessTokenDek: Buffer.from('x'),
          tokenKeyVersion: 1,
        },
      });

      for (const [i, fixture] of fixtures.entries()) {
        const threadId = randomUUID();
        const messageId = randomUUID();
        const receivedAt = new Date(Date.now() - (i + 1) * 3_600_000);

        await tx.emailThread.create({
          data: {
            id: threadId,
            userId,
            accountId,
            providerThreadId: `thr-${fixture.key}-${messageId.slice(0, 6)}`,
            subject: fixture.subject,
            lastMessageAt: receivedAt,
          },
        });

        await tx.emailMessage.create({
          data: {
            id: messageId,
            userId,
            accountId,
            threadId,
            providerMessageId: `msg-${fixture.key}-${messageId.slice(0, 6)}`,
            messageIdHeader: `<${messageId}@acme.com>`,
            subject: fixture.subject,
            fromAddress: fixture.from,
            fromName: fixture.name,
            toAddresses: ['me@example.com'],
            sentAt: receivedAt,
            receivedAt,
            snippet: fixture.subject,
            contentHash: messageId,
          },
        });

        const waId = `wamid.${fixture.key}.${messageId.slice(0, 6)}`;
        await tx.whatsAppDelivery.create({
          data: {
            userId,
            emailMessageId: messageId,
            whatsappMessageId: waId,
            phoneNumber: phone,
            status: 'delivered',
          },
        });

        emails[fixture.key] = messageId;
        deliveries[fixture.key] = waId;
      }

      await tx.contact.create({
        data: {
          userId,
          emailAddress: 'sarah.chen@acme.com',
          displayName: 'Sarah Chen',
          aliases: ['boss'],
        },
      });
    });
  }

  function withTenant<T>(id: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return scopedTx(prisma, id, fn as never) as Promise<T>;
  }

  beforeEach(async () => {
    await withTenant(userId, async (tx) => {
      await tx.conversationState.deleteMany({ where: { userId } });
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  const inbound = (over: Partial<InboundWhatsAppMessage> = {}): InboundWhatsAppMessage => ({
    id: `wamid.IN.${randomUUID().slice(0, 8)}`,
    from: phone.slice(1),
    timestamp: new Date(),
    type: 'text',
    text: 'yes',
    ...over,
  });

  it('finds the user behind a WhatsApp number', async () => {
    const found = await repo.findUserByPhone(phone);
    expect(found?.id).toBe(userId);
    expect(found?.timezone).toBe('Africa/Nairobi');
  });

  it('returns null for an unknown number rather than throwing', async () => {
    expect(await repo.findUserByPhone('+254700000001')).toBeNull();
  });

  it('maps a delivery back to its email — rank 1 end to end', async () => {
    const resolution = await resolver.resolve(inbound({ context: { id: deliveries.sarah! } }), {
      deliveryLookup: (wamid) => repo.findEmailByDelivery(userId, wamid),
      recent: await repo.findRecentCandidates(userId),
    });

    expect(resolution).toMatchObject({
      outcome: 'resolved',
      emailMessageId: emails.sarah,
      rank: 1,
    });
  });

  it('returns candidates newest first, with aliases attached', async () => {
    const candidates = await repo.findRecentCandidates(userId);

    expect(candidates).toHaveLength(3);
    expect(candidates[0]!.fromAddress).toBe('sarah.chen@acme.com');
    expect(candidates[0]!.aliases).toEqual(['boss']);
    // Newest first.
    expect(candidates[0]!.receivedAt.getTime()).toBeGreaterThan(
      candidates[1]!.receivedAt.getTime(),
    );
  });

  it('resolves an alias the user chose, not one the sender did — rank 4', async () => {
    const resolution = await resolver.resolve(inbound({ text: 'reply to boss' }), {
      deliveryLookup: async () => null,
      recent: await repo.findRecentCandidates(userId),
      namedTarget: 'boss',
    });

    expect(resolution).toMatchObject({ emailMessageId: emails.sarah, rank: 4 });
  });

  it('excludes archived mail from the candidate list', async () => {
    await withTenant(userId, async (tx) => {
      await tx.emailMessage.update({ where: { id: emails.tom! }, data: { isArchived: true } });
    });

    const candidates = await repo.findRecentCandidates(userId);
    expect(candidates.map((c) => c.emailMessageId)).not.toContain(emails.tom);

    await withTenant(userId, async (tx) => {
      await tx.emailMessage.update({ where: { id: emails.tom! }, data: { isArchived: false } });
    });
  });

  it('excludes mail the user was never notified about', async () => {
    // An email they never saw is not something they can be replying to.
    const orphanId = randomUUID();
    await withTenant(userId, async (tx) => {
      const threadId = randomUUID();
      await tx.emailThread.create({
        data: {
          id: threadId,
          userId,
          accountId,
          providerThreadId: `thr-orphan-${orphanId.slice(0, 6)}`,
          subject: 'Never delivered',
          lastMessageAt: new Date(),
        },
      });
      await tx.emailMessage.create({
        data: {
          id: orphanId,
          userId,
          accountId,
          threadId,
          providerMessageId: `msg-orphan-${orphanId.slice(0, 6)}`,
          messageIdHeader: `<${orphanId}@acme.com>`,
          subject: 'Never delivered',
          fromAddress: 'silent@acme.com',
          toAddresses: ['me@example.com'],
          sentAt: new Date(),
          receivedAt: new Date(),
          snippet: 'x',
          contentHash: orphanId,
        },
      });
    });

    const candidates = await repo.findRecentCandidates(userId);
    expect(candidates.map((c) => c.emailMessageId)).not.toContain(orphanId);
  });

  describe('tenant isolation holds through the repository', () => {
    it('shows another user none of these emails', async () => {
      expect(await repo.findRecentCandidates(otherUserId)).toHaveLength(0);
    });

    it('will not map a delivery for a user it does not belong to', async () => {
      expect(await repo.findEmailByDelivery(otherUserId, deliveries.sarah!)).toBeNull();
    });
  });

  describe('conversation state', () => {
    it('records the inbound timestamp the messaging window depends on', async () => {
      const at = new Date();
      await repo.touchConversation(userId, at);

      const state = await repo.findConversationState(userId);
      expect(state?.lastInboundAt?.getTime()).toBeCloseTo(at.getTime(), -2);
      expect(state!.expiresAt.getTime()).toBeGreaterThan(at.getTime());
    });

    it('remembers the active email so a follow-up lands on it — rank 3', async () => {
      await repo.touchConversation(userId, new Date(), emails.billing!);

      const state = await repo.findConversationState(userId);
      const resolution = await resolver.resolve(inbound({ text: 'yes' }), {
        deliveryLookup: async () => null,
        activeEmailMessageId: state?.activeEmailMessageId ?? null,
        activeStateExpiresAt: state?.expiresAt ?? null,
        recent: await repo.findRecentCandidates(userId),
      });

      expect(resolution).toMatchObject({ emailMessageId: emails.billing, rank: 3 });
    });

    it('does not clear the active email on an unrelated message', async () => {
      // "help" must not lose the thread the user was working on.
      await repo.touchConversation(userId, new Date(), emails.sarah!);
      await repo.touchConversation(userId, new Date());

      expect((await repo.findConversationState(userId))?.activeEmailMessageId).toBe(emails.sarah);
    });

    it('clears the thread on request', async () => {
      await repo.touchConversation(userId, new Date(), emails.sarah!);
      await repo.clearActiveThread(userId);

      expect((await repo.findConversationState(userId))?.activeEmailMessageId).toBeNull();
    });
  });

  describe('inbound recording', () => {
    it('records a message before it is handled', async () => {
      const message = inbound({ text: 'archive' });
      await repo.recordInbound({
        userId,
        whatsappMessageId: message.id,
        phoneNumber: phone,
        messageType: 'text',
        body: 'archive',
        receivedAt: message.timestamp,
      });

      const stored = await withTenant(userId, (tx) =>
        tx.whatsAppInboundMessage.findUnique({ where: { whatsappMessageId: message.id } }),
      );
      expect(stored?.body).toBe('archive');
      expect(stored?.handledAt).toBeNull();
    });

    it('is idempotent, so a redelivered webhook does not duplicate', async () => {
      const message = inbound({ text: 'yes' });
      const record = {
        userId,
        whatsappMessageId: message.id,
        phoneNumber: phone,
        messageType: 'text',
        body: 'yes',
        receivedAt: message.timestamp,
      };

      await repo.recordInbound(record);
      await repo.recordInbound(record);

      const count = await withTenant(userId, (tx) =>
        tx.whatsAppInboundMessage.count({ where: { whatsappMessageId: message.id } }),
      );
      expect(count).toBe(1);
    });

    it('records how a message was interpreted', async () => {
      const message = inbound({ text: 'delete' });
      await repo.recordInbound({
        userId,
        whatsappMessageId: message.id,
        phoneNumber: phone,
        messageType: 'text',
        receivedAt: message.timestamp,
      });
      await repo.recordResolution(userId, message.id, 'delete', 'deterministic');

      const stored = await withTenant(userId, (tx) =>
        tx.whatsAppInboundMessage.findUnique({ where: { whatsappMessageId: message.id } }),
      );
      expect(stored?.resolvedIntent).toBe('delete');
      expect(stored?.handledAt).not.toBeNull();
    });

    it('records a message from a number with no account', async () => {
      // Anyone can message a business number; it must not throw.
      const message = inbound();
      await expect(
        repo.recordInbound({
          userId: null,
          whatsappMessageId: message.id,
          phoneNumber: '+254700000009',
          messageType: 'text',
          receivedAt: message.timestamp,
        }),
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Delivery receipts.
   *
   * `sent_at`, `delivered_at`, `read_at`, `failed_at`, `error_code` and
   * `error_message` have been in the schema since the first migration, and
   * until now nothing wrote any of them — the job carrying the receipts had no
   * handler, so every one of them dead-lettered.
   *
   * The lookup is deliberately unscoped, because a receipt names a `wamid` and
   * a phone number and nothing else. That makes "does it stay inside the right
   * tenant anyway" a question worth asking of a real database rather than a
   * mock.
   */
  describe('applying a delivery receipt', () => {
    /**
     * A fresh row per test.
     *
     * The suite's shared fixtures are seeded once and never reset, and every
     * test here writes to the row it names — sharing one would make the results
     * depend on the order vitest happens to run them in.
     */
    let waId: string;

    beforeEach(async () => {
      waId = `wamid.RECEIPT.${randomUUID().slice(0, 8)}`;
      await withTenant(userId, (tx) =>
        tx.whatsAppDelivery.create({
          data: {
            userId,
            emailMessageId: emails['sarah']!,
            whatsappMessageId: waId,
            phoneNumber: phone,
            status: 'sent',
          },
        }),
      );
    });

    const receipt = (over: Partial<WhatsAppStatusUpdate> = {}): WhatsAppStatusUpdate => ({
      messageId: waId,
      recipient: phone.slice(1),
      status: 'delivered',
      timestamp: new Date('2026-08-20T10:00:00.000Z'),
      ...over,
    });

    async function row() {
      return withTenant(userId, (tx) =>
        tx.whatsAppDelivery.findUnique({ where: { whatsappMessageId: waId } }),
      );
    }

    it('stamps the column the status names', async () => {
      await repo.applyDeliveryReceipt(receipt({ status: 'read' }));

      const stored = await row();
      expect(stored?.status).toBe('read');
      expect(stored?.readAt?.toISOString()).toBe('2026-08-20T10:00:00.000Z');
    });

    it('records a failure with the reason, which is the whole point', async () => {
      // Meta answers a send with 200 and reports the failure seconds later. A
      // receipt that goes nowhere means the system believes it delivered mail
      // the user never got.
      await repo.applyDeliveryReceipt(
        receipt({
          status: 'failed',
          error: { code: 131_047, title: 'Re-engagement message', details: 'outside the window' },
        }),
      );

      const stored = await row();
      expect(stored?.status).toBe('failed');
      expect(stored?.failedAt).not.toBeNull();
      expect(stored?.errorCode).toBe(131_047);
      expect(stored?.errorMessage).toBe('Re-engagement message: outside the window');
    });

    it('returns who it belongs to, since the receipt does not say', async () => {
      const found = await repo.applyDeliveryReceipt(receipt());

      expect(found?.userId).toBe(userId);
      expect(found?.emailMessageId).toBe(emails['sarah']);
    });

    it('shrugs at a receipt for a message it has no record of', async () => {
      // Another tool sending on the same number, or a row lost to a restore.
      // Ordinary, and nothing to do about it.
      await expect(
        repo.applyDeliveryReceipt(receipt({ messageId: 'wamid.NEVER.SENT' })),
      ).resolves.toBeNull();
    });

    it('leaves the other statuses on their own columns', async () => {
      await repo.applyDeliveryReceipt(receipt({ status: 'sent' }));
      await repo.applyDeliveryReceipt(
        receipt({ status: 'delivered', timestamp: new Date('2026-08-20T10:00:05.000Z') }),
      );

      const stored = await row();
      expect(stored?.sentAt?.toISOString()).toBe('2026-08-20T10:00:00.000Z');
      expect(stored?.deliveredAt?.toISOString()).toBe('2026-08-20T10:00:05.000Z');
      // The last receipt wins the status, and the earlier stamps survive it.
      expect(stored?.status).toBe('delivered');
      expect(stored?.readAt).toBeNull();
    });

    it('shrugs at a receipt for a number with no account', async () => {
      // Another tool sending on the same WhatsApp number, or a user who has
      // since changed theirs.
      await expect(
        repo.applyDeliveryReceipt(receipt({ recipient: '254700000077' })),
      ).resolves.toBeNull();
    });

    it("will not let one number stamp another number's delivery", async () => {
      // The `wamid` in a receipt comes off the wire. Resolving the owner from
      // the phone number first — rather than looking the `wamid` up across all
      // tenants — is what keeps a forged one confined to the account that owns
      // the number in the same payload.
      const otherPhone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
      await prisma.user.update({
        where: { id: otherUserId },
        data: { phoneNumber: otherPhone, phoneVerified: true },
      });

      const applied = await repo.applyDeliveryReceipt(
        receipt({ status: 'read', recipient: otherPhone.slice(1) }),
      );

      expect(applied).toBeNull();
      expect((await row())?.status).toBe('sent');
    });

    it('writes inside the owning tenant, not the one that asked', async () => {
      // The lookup crosses tenants by necessity. The update must not: a
      // receipt is attacker-influenced input — the `wamid` comes off the wire.
      await repo.applyDeliveryReceipt(receipt({ status: 'read' }));

      const visibleToOther = await withTenant(otherUserId, (tx) =>
        tx.whatsAppDelivery.findMany({ where: { whatsappMessageId: waId } }),
      );
      expect(visibleToOther).toHaveLength(0);
    });
  });
});
