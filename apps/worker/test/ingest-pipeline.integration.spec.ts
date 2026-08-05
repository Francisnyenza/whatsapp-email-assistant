import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { MessageRepository } from '../src/repositories/message.repository.js';
import { IngestProcessor } from '../src/processors/ingest.processor.js';
import { NotifyProcessor } from '../src/processors/notify.processor.js';
import { AppError, type NormalizedMessage } from '@wea/shared';

/**
 * Email arriving, end to end, against a real database.
 *
 * Everything is real except the Gmail API and the Meta send — the two things
 * that cannot run here. What is exercised is the part that carries the risk:
 * idempotency under redelivery, cursor handling, and the delivery policy
 * actually being honoured.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('ingest pipeline (real database)', () => {
  let prisma: PrismaClient;
  let messages: MessageRepository;
  let ingest: IngestProcessor;
  let notify: NotifyProcessor;

  let enqueued: Array<{ queue: string; payload: any; opts: any }>;
  let sent: Array<{ kind: string; emailMessageId?: string; payload: any }>;
  let providerMessages: Map<string, NormalizedMessage>;
  let changes: Array<{ type: string; providerMessageId: string }>;
  let fetchChangesImpl: (() => AsyncIterable<any>) | null;

  const userId = randomUUID();
  const accountId = randomUUID();
  const phone = `+2547${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  const withTenant = <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> =>
    scopedTx(prisma, userId, fn as never) as Promise<T>;

  const message = (over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
    providerMessageId: `gm-${randomUUID().slice(0, 8)}`,
    providerThreadId: `gt-${randomUUID().slice(0, 8)}`,
    messageIdHeader: `<${randomUUID()}@acme.com>`,
    references: [],
    subject: 'Q3 sales report',
    from: { name: 'Sarah Chen', address: 'sarah.chen@acme.com' },
    to: [{ address: 'me@example.com' }],
    cc: [],
    bcc: [],
    sentAt: new Date(),
    receivedAt: new Date(),
    bodyText: 'Could you send the Q3 report before Friday?',
    snippet: 'Could you send the Q3 report before Friday?',
    attachments: [],
    isUnread: true,
    isStarred: false,
    isDraft: false,
    labels: ['INBOX', 'UNREAD'],
    sizeBytes: 512,
    ...over,
  });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });

    messages = new MessageRepository(service as never);
    enqueued = [];
    sent = [];
    providerMessages = new Map();
    changes = [];
    fetchChangesImpl = null;

    const provider = {
      fetchChanges: () =>
        fetchChangesImpl
          ? fetchChangesImpl()
          : (async function* () {
              for (const change of changes) yield change;
            })(),
      getMessage: async (_a: unknown, id: string) => {
        const found = providerMessages.get(id);
        if (!found) throw new AppError('NOT_FOUND', 'gone', { retryable: false });
        return found;
      },
      getInitialCursor: async () => 'fresh-cursor-999',
    };

    const accounts = {
      load: async () => ({
        id: accountId,
        userId,
        emailAddress: 'me@example.com',
        accessToken: 'x',
      }),
      providerFor: () => provider,
      markReauthRequired: vi.fn(),
    };

    const queue = {
      enqueue: vi.fn(async (queueName: string, _job: string, payload: any, opts: any) => {
        enqueued.push({ queue: queueName, payload, opts });
      }),
    };

    const outbound = {
      reply: vi.fn(async (input: any) => {
        sent.push({
          kind: input.kind,
          emailMessageId: input.emailMessageId,
          payload: input.payload,
        });
      }),
    };

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const config = { env: { REDIS_URL: 'redis://unused' } };

    ingest = new IngestProcessor(
      config as never,
      accounts as never,
      messages,
      queue as never,
      logger as never,
    );
    notify = new NotifyProcessor(config as never, messages, outbound as never, logger as never);

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        status: 'active',
        phoneNumber: phone,
        timezone: 'Africa/Nairobi',
        locale: 'en-GB',
      },
    });

    await withTenant(async (tx) => {
      await tx.emailAccount.create({
        data: {
          id: accountId,
          userId,
          provider: 'gmail',
          emailAddress: 'me@example.com',
          status: 'active',
          providerAccountId: `acct-${userId.slice(0, 8)}`,
          accessTokenCipher: new Uint8Array([1]),
          accessTokenDek: new Uint8Array([1]),
          tokenKeyVersion: 1,
          syncCursor: '1000',
        },
      });
      await tx.userPreference.create({ data: { userId } });
      await tx.conversationState.create({
        data: { userId, lastInboundAt: new Date(), expiresAt: new Date(Date.now() + 600_000) },
      });
    });
  });

  beforeEach(() => {
    enqueued.length = 0;
    sent.length = 0;
    changes.length = 0;
    providerMessages.clear();
    fetchChangesImpl = null;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const runIngest = (cursor = '1000') =>
    ingest.handle({ data: { userId, accountId, cursor } } as never);

  function stageIncoming(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
    const staged = message(over);
    providerMessages.set(staged.providerMessageId, staged);
    changes.push({ type: 'messageAdded', providerMessageId: staged.providerMessageId });
    return staged;
  }

  describe('persistence', () => {
    it('stores a new message with its thread', async () => {
      const incoming = stageIncoming();
      await runIngest();

      const stored = await withTenant((tx) =>
        tx.emailMessage.findUnique({
          where: {
            accountId_providerMessageId: {
              accountId,
              providerMessageId: incoming.providerMessageId,
            },
          },
          include: { thread: true },
        }),
      );

      expect(stored).not.toBeNull();
      expect((stored as any).subject).toBe('Q3 sales report');
      expect((stored as any).fromAddress).toBe('sarah.chen@acme.com');
      expect((stored as any).thread.providerThreadId).toBe(incoming.providerThreadId);
    });

    it('does not store the same message twice, however often it is redelivered', async () => {
      // Gmail redelivers history freely and a reconcile sweep re-walks the same
      // ground on purpose. Both land here.
      const incoming = stageIncoming();

      await runIngest();
      await runIngest();
      await runIngest();

      const count = await withTenant((tx) =>
        tx.emailMessage.count({ where: { providerMessageId: incoming.providerMessageId } }),
      );
      expect(count).toBe(1);
    });

    it('notifies only for the first delivery', async () => {
      // The most visible bug this system could have is telling someone about
      // the same email three times.
      stageIncoming();

      await runIngest();
      const afterFirst = enqueued.filter((e) => e.queue === 'notify').length;

      await runIngest();
      const afterSecond = enqueued.filter((e) => e.queue === 'notify').length;

      expect(afterFirst).toBe(1);
      expect(afterSecond).toBe(1);
    });

    it('keys the notify job on our own row id', async () => {
      stageIncoming();
      await runIngest();

      const job = enqueued.find((e) => e.queue === 'notify');
      expect(job!.opts.jobId).toMatch(/^notify:/);
    });

    it('groups messages in one conversation under one thread', async () => {
      const threadId = `gt-shared-${randomUUID().slice(0, 6)}`;
      stageIncoming({ providerThreadId: threadId, subject: 'First' });
      stageIncoming({ providerThreadId: threadId, subject: 'Second' });

      await runIngest();

      const threads = await withTenant((tx) =>
        tx.emailThread.findMany({ where: { providerThreadId: threadId } }),
      );
      expect(threads).toHaveLength(1);
      expect(threads[0]!.messageCount).toBe(2);
    });

    it('stores attachments alongside the message', async () => {
      const incoming = stageIncoming({
        attachments: [
          {
            providerAttachmentId: 'att-1',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            disposition: 'attachment',
          },
        ],
      });

      await runIngest();

      const stored = await withTenant((tx) =>
        tx.emailMessage.findUnique({
          where: {
            accountId_providerMessageId: {
              accountId,
              providerMessageId: incoming.providerMessageId,
            },
          },
          include: { attachments: true },
        }),
      );

      expect((stored as any).hasAttachments).toBe(true);
      expect((stored as any).attachments[0].filename).toBe('report.pdf');
    });

    it('gives identical content the same hash across mailboxes', async () => {
      // What lets one newsletter share a single AI analysis rather than paying
      // for it per recipient.
      const a = stageIncoming({ subject: 'Weekly digest', bodyText: 'The same body.' });
      const b = stageIncoming({ subject: 'Weekly  DIGEST ', bodyText: 'The  same body. ' });

      await runIngest();

      const rows = await withTenant((tx) =>
        tx.emailMessage.findMany({
          where: { providerMessageId: { in: [a.providerMessageId, b.providerMessageId] } },
          select: { contentHash: true },
        }),
      );
      expect(rows[0]!.contentHash).toBe(rows[1]!.contentHash);
    });
  });

  describe('cursor handling', () => {
    it('advances only after the batch succeeds', async () => {
      stageIncoming();
      await runIngest();

      const account = await withTenant((tx) =>
        tx.emailAccount.findUnique({ where: { id: accountId } }),
      );
      expect((account as any).lastSyncedAt).not.toBeNull();
    });

    it('leaves the cursor alone when the batch fails', async () => {
      // Advancing past mail we failed to fetch means the user never learns it
      // arrived — worse than processing something twice.
      const before = await withTenant((tx) =>
        tx.emailAccount.findUnique({ where: { id: accountId }, select: { syncCursor: true } }),
      );

      fetchChangesImpl = () =>
        (async function* () {
          throw new AppError('PROVIDER_ERROR', 'Gmail is down', { retryable: true });
          // eslint-disable-next-line no-unreachable
          yield undefined;
        })();

      await expect(runIngest()).rejects.toThrow(AppError);

      const after = await withTenant((tx) =>
        tx.emailAccount.findUnique({ where: { id: accountId }, select: { syncCursor: true } }),
      );
      expect((after as any).syncCursor).toBe((before as any).syncCursor);
    });

    it('records a sync failure for the health view', async () => {
      fetchChangesImpl = () =>
        (async function* () {
          throw new AppError('PROVIDER_ERROR', 'Gmail is down', { retryable: true });
          // eslint-disable-next-line no-unreachable
          yield undefined;
        })();

      await expect(runIngest()).rejects.toThrow();

      const account = await withTenant((tx) =>
        tx.emailAccount.findUnique({ where: { id: accountId } }),
      );
      expect((account as any).consecutiveFailures).toBeGreaterThan(0);
      expect((account as any).lastErrorCode).toBe('PROVIDER_ERROR');
    });

    it('resynchronises instead of failing when the cursor is too old', async () => {
      // Normal for an account that was paused — Gmail keeps history about a week.
      fetchChangesImpl = () =>
        (async function* () {
          throw new AppError('CONFLICT', 'history expired', { retryable: false });
          // eslint-disable-next-line no-unreachable
          yield undefined;
        })();

      await expect(runIngest()).resolves.toBeUndefined();

      const account = await withTenant((tx) =>
        tx.emailAccount.findUnique({ where: { id: accountId }, select: { syncCursor: true } }),
      );
      expect((account as any).syncCursor).toBe('fresh-cursor-999');
    });

    it('skips a message that vanished between the history record and the fetch', async () => {
      // Ordinary: the user deleted it elsewhere. One vanished message must not
      // fail the whole batch.
      changes.push({ type: 'messageAdded', providerMessageId: 'gm-deleted-already' });
      const survivor = stageIncoming();

      await expect(runIngest()).resolves.toBeUndefined();

      const stored = await withTenant((tx) =>
        tx.emailMessage.count({ where: { providerMessageId: survivor.providerMessageId } }),
      );
      expect(stored).toBe(1);
    });
  });

  describe('delivery', () => {
    const notifyFor = async (emailMessageId: string, force = false) =>
      notify.handle({ data: { userId, emailMessageId, force } } as never);

    const idOf = async (providerMessageId: string) => {
      const row = await withTenant((tx) =>
        tx.emailMessage.findUnique({
          where: { accountId_providerMessageId: { accountId, providerMessageId } },
          select: { id: true },
        }),
      );
      return (row as any).id as string;
    };

    it('delivers the email as a WhatsApp card', async () => {
      const incoming = stageIncoming();
      await runIngest();
      await notifyFor(await idOf(incoming.providerMessageId));

      expect(sent).toHaveLength(1);
      expect(sent[0]!.kind).toBe('notification');
      expect(sent[0]!.payload.body).toContain('Sarah Chen');
      expect(sent[0]!.payload.body).toContain('Q3 sales report');
    });

    it('records the delivery so the user can reply to it', async () => {
      const incoming = stageIncoming();
      await runIngest();
      const emailMessageId = await idOf(incoming.providerMessageId);
      await notifyFor(emailMessageId);

      expect(sent[0]!.emailMessageId).toBe(emailMessageId);
    });

    it('honours a muted sender', async () => {
      await withTenant(async (tx) => {
        await tx.userPreference.update({
          where: { userId },
          data: { mutedSenders: ['sarah.chen@acme.com'] },
        });
      });

      const incoming = stageIncoming();
      await runIngest();
      await notifyFor(await idOf(incoming.providerMessageId));

      expect(sent).toHaveLength(0);

      await withTenant(async (tx) => {
        await tx.userPreference.update({ where: { userId }, data: { mutedSenders: [] } });
      });
    });

    it('holds everything in digest mode', async () => {
      await withTenant(async (tx) => {
        await tx.userPreference.update({
          where: { userId },
          data: { notificationMode: 'digest' },
        });
      });

      const incoming = stageIncoming();
      await runIngest();
      await notifyFor(await idOf(incoming.providerMessageId));

      expect(sent).toHaveLength(0);

      await withTenant(async (tx) => {
        await tx.userPreference.update({
          where: { userId },
          data: { notificationMode: 'instant' },
        });
      });
    });

    it('delivers anyway when forced, bypassing preferences', async () => {
      await withTenant(async (tx) => {
        await tx.userPreference.update({
          where: { userId },
          data: { notificationMode: 'off' },
        });
      });

      const incoming = stageIncoming();
      await runIngest();
      await notifyFor(await idOf(incoming.providerMessageId), true);

      expect(sent).toHaveLength(1);

      await withTenant(async (tx) => {
        await tx.userPreference.update({
          where: { userId },
          data: { notificationMode: 'instant' },
        });
      });
    });

    it('delivers without an AI summary rather than not at all', async () => {
      // Summarisation is not built. Even once it is, a failed model call must
      // never block delivery.
      const incoming = stageIncoming();
      await runIngest();
      await notifyFor(await idOf(incoming.providerMessageId));

      expect(sent).toHaveLength(1);
      expect(sent[0]!.payload.body).toContain('Q3 sales report');
    });

    it('does nothing when the email has since been deleted', async () => {
      await expect(notifyFor(randomUUID())).resolves.toBeUndefined();
      expect(sent).toHaveLength(0);
    });
  });
});
