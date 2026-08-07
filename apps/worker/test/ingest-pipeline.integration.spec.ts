import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { MessageRepository } from '../src/repositories/message.repository.js';
import { IngestProcessor } from '../src/processors/ingest.processor.js';
import { NotifyProcessor } from '../src/processors/notify.processor.js';
import { MAX_STORED_BODY_BYTES } from '../src/processors/ingest.processor.js';
import { AppError, type NormalizedMessage } from '@wea/shared';
import { EnvelopeEncryption, LocalKmsProvider } from '@wea/crypto';
import { randomBytes } from 'node:crypto';

const bodyCrypto = new EnvelopeEncryption(new LocalKmsProvider(randomBytes(32)));

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
  let sent: Array<{
    kind: string;
    emailMessageId?: string;
    payload: any;
    allowOutsideWindow?: boolean;
  }>;
  let providerMessages: Map<string, NormalizedMessage>;
  let changes: Array<{ type: string; providerMessageId: string }>;
  let fetchChangesImpl: (() => AsyncIterable<any>) | null;
  /** Set to make sealing the body fail, so the fallback path can be exercised. */
  let sealFailure: Error | null = null;

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
      // Real envelope encryption, so a stored body genuinely round-trips
      // through the code path production uses — including the AAD binding it to
      // this user and to the messageBody field.
      encryptMessageBody: (id: string, body: string) => {
        if (sealFailure) throw sealFailure;
        return bodyCrypto.encryptString(body, { userId: id, field: 'messageBody' });
      },
      decryptMessageBody: (
        id: string,
        sealed: { ciphertext: Buffer; wrappedKey: Buffer; keyVersion: number },
      ) => bodyCrypto.decryptString(sealed, { userId: id, field: 'messageBody' }),
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
          allowOutsideWindow: input.allowOutsideWindow === true,
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
    sealFailure = null;
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

  /** Ingests one message and returns our own row id for it. */
  async function ingestOne(staged: NormalizedMessage): Promise<string> {
    providerMessages.set(staged.providerMessageId, staged);
    changes.push({ type: 'messageAdded', providerMessageId: staged.providerMessageId });
    await runIngest();

    const stored = await withTenant((tx) =>
      tx.emailMessage.findUnique({
        where: {
          accountId_providerMessageId: {
            accountId,
            providerMessageId: staged.providerMessageId,
          },
        },
        select: { id: true },
      }),
    );
    return (stored as { id: string }).id;
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

    describe('outside the messaging window', () => {
      /**
       * The 24-hour window is the whole reason templates exist. A free-form
       * message sent past it is accepted by the API and then never delivered —
       * no error anywhere, and a user who simply stops hearing from us.
       */
      const closeWindow = () =>
        withTenant((tx) =>
          tx.conversationState.update({
            where: { userId },
            data: { lastInboundAt: new Date(Date.now() - 25 * 3_600_000) },
          }),
        );

      /**
       * A template send costs money, so it is reserved for mail the user said
       * they want immediately; anything ordinary waits for the digest. These
       * tests are about the template path, so the message is marked high.
       */
      const markHighPriority = (emailMessageId: string) =>
        withTenant((tx) =>
          tx.messageAnalysis.create({
            data: {
              userId,
              emailMessageId,
              summary: 'Needs an answer today',
              priority: 'high',
              modelProvider: 'test',
              model: 'test',
            },
          }),
        );

      const openWindow = () =>
        withTenant((tx) =>
          tx.conversationState.update({ where: { userId }, data: { lastInboundAt: new Date() } }),
        );

      it('sends an approved template instead of a card', async () => {
        await closeWindow();
        const incoming = stageIncoming();
        await runIngest();
        const emailMessageId = await idOf(incoming.providerMessageId);
        await markHighPriority(emailMessageId);
        await notifyFor(emailMessageId);
        await openWindow();

        expect(sent).toHaveLength(1);
        expect(sent[0]!.payload.kind).toBe('template');
        expect(sent[0]!.payload.name).toBe('new_email_notification');
      });

      it('carries the sender and subject as parameters', async () => {
        await closeWindow();
        const incoming = stageIncoming();
        await runIngest();
        const emailMessageId = await idOf(incoming.providerMessageId);
        await markHighPriority(emailMessageId);
        await notifyFor(emailMessageId);
        await openWindow();

        expect(sent[0]!.payload.components[0].parameters.map((p: any) => p.text)).toEqual([
          'Sarah Chen',
          'Q3 sales report',
        ]);
      });

      it('names the window exception explicitly', async () => {
        // The flag is what lets this past the outbound window check, and it is
        // only ever set for a template.
        await closeWindow();
        const incoming = stageIncoming();
        await runIngest();
        const emailMessageId = await idOf(incoming.providerMessageId);
        await markHighPriority(emailMessageId);
        await notifyFor(emailMessageId);
        await openWindow();

        expect(sent[0]!.allowOutsideWindow).toBe(true);
      });

      it('still records which email it was about', async () => {
        await closeWindow();
        const incoming = stageIncoming();
        await runIngest();
        const emailMessageId = await idOf(incoming.providerMessageId);
        await markHighPriority(emailMessageId);
        await notifyFor(emailMessageId);
        await openWindow();

        expect(sent[0]!.emailMessageId).toBe(emailMessageId);
      });

      it('defers ordinary mail rather than paying for a template', async () => {
        // A template send is billable, so it is reserved for mail the user said
        // they want immediately. Everything else waits for the digest they get
        // when they next message us.
        await closeWindow();
        const incoming = stageIncoming();
        await runIngest();
        await notifyFor(await idOf(incoming.providerMessageId));
        await openWindow();

        expect(sent).toHaveLength(0);
      });

      it('sends the card, not a template, once the window is open', async () => {
        const incoming = stageIncoming();
        await runIngest();
        const emailMessageId = await idOf(incoming.providerMessageId);
        await markHighPriority(emailMessageId);
        await notifyFor(emailMessageId);

        expect(sent[0]!.payload.kind).not.toBe('template');
        expect(sent[0]!.allowOutsideWindow).toBe(false);
      });
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

  describe('the message body', () => {
    /**
     * Ingest stored only a snippet for a long time, which made the encryption
     * the schema describes for `body_text_cipher` dead weight and would have
     * left the AI layer with nothing to read. These pin the fix.
     */
    const bodyOf = async (emailMessageId: string) => {
      const row = await withTenant((tx) =>
        tx.emailMessage.findUnique({ where: { id: emailMessageId } }),
      );
      if (!row!.bodyTextCipher) return null;
      return bodyCrypto.decryptString(
        {
          ciphertext: Buffer.from(row!.bodyTextCipher),
          wrappedKey: Buffer.from(row!.bodyDek!),
          keyVersion: row!.bodyKeyVersion!,
        },
        { userId, field: 'messageBody' },
      );
    };

    it('is stored, encrypted, and reads back', async () => {
      const msg = message({ bodyText: 'Could you send the Q3 report before Friday?' });
      const id = await ingestOne(msg);

      expect(await bodyOf(id)).toBe('Could you send the Q3 report before Friday?');
    });

    it('is not readable without decrypting', async () => {
      const msg = message({ bodyText: 'Wire the deposit to account 4471.' });
      const id = await ingestOne(msg);

      const row = await withTenant((tx) => tx.emailMessage.findUnique({ where: { id } }));
      expect(Buffer.from(row!.bodyTextCipher!).toString('utf8')).not.toContain('4471');
    });

    it('is bound to this user, so another tenant’s key cannot open it', async () => {
      const msg = message({ bodyText: 'Confidential.' });
      const id = await ingestOne(msg);
      const row = await withTenant((tx) => tx.emailMessage.findUnique({ where: { id } }));

      await expect(
        bodyCrypto.decryptString(
          {
            ciphertext: Buffer.from(row!.bodyTextCipher!),
            wrappedKey: Buffer.from(row!.bodyDek!),
            keyVersion: row!.bodyKeyVersion!,
          },
          { userId: randomUUID(), field: 'messageBody' },
        ),
      ).rejects.toThrow();
    });

    it('is bound to its field, so it cannot be opened as a draft body', async () => {
      // The two have different lifetimes — a received body is purged on the
      // retention schedule and a draft is not — so ciphertext moved between the
      // columns must fail rather than quietly surface in the wrong place.
      const msg = message({ bodyText: 'Confidential.' });
      const id = await ingestOne(msg);
      const row = await withTenant((tx) => tx.emailMessage.findUnique({ where: { id } }));

      await expect(
        bodyCrypto.decryptString(
          {
            ciphertext: Buffer.from(row!.bodyTextCipher!),
            wrappedKey: Buffer.from(row!.bodyDek!),
            keyVersion: row!.bodyKeyVersion!,
          },
          { userId, field: 'draftBody' },
        ),
      ).rejects.toThrow();
    });

    it('is truncated rather than storing megabytes of inline markup', async () => {
      const huge = 'x'.repeat(MAX_STORED_BODY_BYTES + 50_000);
      const id = await ingestOne(message({ bodyText: huge }));

      const stored = await bodyOf(id);
      expect(stored!.length).toBeLessThan(huge.length);
      // Visible, so a message that seems to stop mid-sentence is explained.
      expect(stored).toContain('[Message truncated.]');
    });

    it('stores an empty body as no body rather than as ciphertext', async () => {
      // Plenty of mail is subject-only. The pairing CHECK permits both columns
      // NULL, and that is what an absent body should look like.
      const id = await ingestOne(message({ bodyText: '' }));

      expect(await bodyOf(id)).toBeNull();
    });

    it('still delivers the email when the body cannot be encrypted', async () => {
      // A notification the user receives beats a message dropped over an
      // encryption failure. The body can be re-fetched; the notification cannot.
      sealFailure = new Error('kms unavailable');
      const id = await ingestOne(message({ bodyText: 'Important.' }));

      expect(await bodyOf(id)).toBeNull();
      // Ingest's job is to persist and hand off; the notification is queued.
      expect(enqueued.filter((e) => e.payload.emailMessageId === id)).toHaveLength(1);
    });
  });
});
