import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { SessionService } from '../src/auth/session.service.js';
import { AppError } from '@wea/shared';

/**
 * Refresh-token rotation and theft detection, against a real database.
 *
 * A stolen refresh token is indistinguishable from a real one, so the design
 * does not try to tell them apart — it makes reuse detectable and responds by
 * revoking everything. These tests are that behaviour, and the race in the
 * middle of them only exists at the database.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

describeIfDb('refresh rotation (real database)', () => {
  let prisma: PrismaClient;
  let sessions: SessionService;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const userId = randomUUID();
  const ctx = { userAgent: 'vitest', ipAddress: '127.0.0.1' };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });

    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sessions = new SessionService(service as never, { record: vi.fn() } as never, logger as never);

    await prisma.user.create({
      data: { id: userId, email: `${userId.slice(0, 8)}@example.com`, status: 'active' },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const activeCount = () =>
    scopedTx(prisma, userId, (tx) =>
      (tx as unknown as PrismaClient).session.count({ where: { revokedAt: null } }),
    ) as Promise<number>;

  it('issues a usable refresh token', async () => {
    const issued = await sessions.create(userId, ctx);

    expect(issued.refreshToken).toMatch(/^wea_rt_/);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('never stores the token itself', async () => {
    const issued = await sessions.create(userId, ctx);

    const stored = await scopedTx(prisma, userId, (tx) =>
      (tx as unknown as PrismaClient).session.findUnique({ where: { id: issued.sessionId } }),
    );

    expect((stored as any).refreshTokenHash).not.toBe(issued.refreshToken);
    expect((stored as any).refreshTokenHash).toHaveLength(64);
  });

  it('rotates to a new token and keeps the family', async () => {
    const first = await sessions.create(userId, ctx);
    const second = await sessions.rotate(first.refreshToken, ctx);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    // Same login, so the family carries across — that is what makes reuse
    // detection able to revoke the right set.
    expect(second.familyId).toBe(first.familyId);
  });

  it('refuses the token it just replaced', async () => {
    const first = await sessions.create(userId, ctx);
    await sessions.rotate(first.refreshToken, ctx);

    await expect(sessions.rotate(first.refreshToken, ctx)).rejects.toThrow(AppError);
  });

  describe('theft detection', () => {
    it('revokes the whole family when a rotated token is presented again', async () => {
      // The scenario: an attacker steals a token, the real user refreshes
      // first, then the attacker tries theirs. Both are cut off.
      const login = await sessions.create(userId, ctx);
      const stolen = login.refreshToken;

      const legitimate = await sessions.rotate(login.refreshToken, ctx);
      // The real user now holds a working token.
      expect(legitimate.refreshToken).toBeTruthy();

      await expect(sessions.rotate(stolen, ctx)).rejects.toThrow(AppError);

      // And the real user's token is dead too — the correct, deliberate cost.
      await expect(sessions.rotate(legitimate.refreshToken, ctx)).rejects.toThrow(AppError);
    });

    it('logs the detection at error level so it can be alerted on', async () => {
      logger.error.mockClear();

      const login = await sessions.create(userId, ctx);
      await sessions.rotate(login.refreshToken, ctx);
      await sessions.rotate(login.refreshToken, ctx).catch(() => undefined);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'auth.refresh_reuse_detected' }),
        expect.any(String),
      );
    });

    it('leaves other login families untouched', async () => {
      // Signing in on a laptop should not be affected by theft on a phone.
      const phone = await sessions.create(userId, ctx);
      const laptop = await sessions.create(userId, ctx);

      await sessions.rotate(phone.refreshToken, ctx);
      await sessions.rotate(phone.refreshToken, ctx).catch(() => undefined);

      // The laptop's family is a different one and still works.
      await expect(sessions.rotate(laptop.refreshToken, ctx)).resolves.toBeTruthy();
    });
  });

  it('refuses a token that was explicitly revoked', async () => {
    const issued = await sessions.create(userId, ctx);
    await sessions.revoke(userId, issued.refreshToken);

    await expect(sessions.rotate(issued.refreshToken, ctx)).rejects.toThrow(AppError);
  });

  it('refuses a token that never existed', async () => {
    await expect(sessions.rotate('wea_rt_fabricated', ctx)).rejects.toThrow(AppError);
  });

  it('gives one message for every rejection', async () => {
    // Distinguishing "unknown" from "expired" from "reused" tells an attacker
    // whether a token they hold was ever real.
    const issued = await sessions.create(userId, ctx);
    await sessions.rotate(issued.refreshToken, ctx);

    const messages = new Set<string>();
    for (const token of ['wea_rt_nonsense', issued.refreshToken]) {
      await sessions.rotate(token, ctx).catch((err: AppError) => {
        messages.add(err.publicMessage);
      });
    }

    expect(messages.size).toBe(1);
  });

  it('signs out everywhere and invalidates outstanding access tokens', async () => {
    const before = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokensValidFrom: true },
    });

    await sessions.create(userId, ctx);
    await new Promise((r) => setTimeout(r, 5));
    await sessions.revokeAll(userId, 'test');

    expect(await activeCount()).toBe(0);

    // tokensValidFrom moves forward, which is what invalidates access tokens
    // the stateless verifier cannot otherwise revoke.
    const after = await prisma.user.findUnique({
      where: { id: userId },
      select: { tokensValidFrom: true },
    });
    expect(after!.tokensValidFrom.getTime()).toBeGreaterThan(before!.tokensValidFrom.getTime());
  });

  it('lists only live sessions, and never exposes the token hash', async () => {
    await sessions.revokeAll(userId, 'reset for test');

    const live = await sessions.create(userId, ctx);
    const rotatedAway = await sessions.create(userId, ctx);
    await sessions.rotate(rotatedAway.refreshToken, ctx);

    const active = await sessions.listActive(userId);

    // The rotated-away session is excluded; its replacement and `live` remain.
    expect(active.some((s) => s.id === live.sessionId)).toBe(true);
    expect(active.some((s) => s.id === rotatedAway.sessionId)).toBe(false);
    for (const session of active) {
      expect(session).not.toHaveProperty('refreshTokenHash');
    }
  });

  /**
   * Two requests presenting one token at the same moment.
   *
   * The check at the top of `rotate` is a read followed by a write, and until
   * recently that was the only check: two concurrent requests each read
   * `replacedById = null`, each passed, each issued a replacement, and reuse
   * detection never fired. Both callers got a working session and neither knew
   * the other existed.
   *
   * That is the exact case invariant 8 exists for. An attacker who uses a
   * stolen token *later* was always caught; one who used it at the same moment
   * as its owner was not caught at all — and "at the same moment" is what a
   * script does when it steals a token from a page that is actively refreshing.
   *
   * Found by sending two simultaneous refreshes at a running API and getting
   * two different, both-live tokens back. It only exists at the database, so
   * this is where it is pinned: `Promise.all` on the same client, both requests
   * genuinely in flight, not two sequential calls to a mock.
   */
  describe('two requests, one token', () => {
    it('lets exactly one through and treats the other as theft', async () => {
      const first = await sessions.create(userId, ctx);

      const [a, b] = await Promise.allSettled([
        sessions.rotate(first.refreshToken, ctx),
        sessions.rotate(first.refreshToken, ctx),
      ]);

      const outcomes = [a.status, b.status].sort();
      expect(outcomes).toEqual(['fulfilled', 'rejected']);
    });

    it('leaves no live token behind, including the winner’s', async () => {
      // The response to detected reuse is to revoke the family, and the
      // replacement issued moments earlier belongs to it. Without that, the
      // loser's request would leave a live orphan token nobody holds — or
      // worse, one the attacker holds.
      const first = await sessions.create(userId, ctx);

      const settled = await Promise.allSettled([
        sessions.rotate(first.refreshToken, ctx),
        sessions.rotate(first.refreshToken, ctx),
      ]);

      const winner = settled.find((r) => r.status === 'fulfilled');
      const issued = (winner as PromiseFulfilledResult<{ refreshToken: string }>).value;

      await expect(sessions.rotate(issued.refreshToken, ctx)).rejects.toThrow(AppError);
    });

    it('says the same thing to both, as every rejection here does', async () => {
      // A rejection that explained *why* would tell an attacker whether they
      // raced a real client or simply held a dead token.
      const first = await sessions.create(userId, ctx);

      const settled = await Promise.allSettled([
        sessions.rotate(first.refreshToken, ctx),
        sessions.rotate(first.refreshToken, ctx),
      ]);

      const loser = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((loser.reason as AppError).publicMessage).toBe(
        'Your session has expired. Please sign in again.',
      );
    });

    it('records it, and marks it as the concurrent case', async () => {
      // Distinguishable in the trail even though it is not distinguishable in
      // the response: an investigator wants to know whether the second party
      // appeared a millisecond later or an hour later.
      const audit = { record: vi.fn() };
      const service = Object.assign(prisma, {
        forUser: <T>(id: string, fn: (tx: never) => Promise<T>) =>
          scopedTx(prisma, id, fn as never),
      });
      const watched = new SessionService(service as never, audit as never, logger as never);

      const first = await watched.create(userId, ctx);
      await Promise.allSettled([
        watched.rotate(first.refreshToken, ctx),
        watched.rotate(first.refreshToken, ctx),
      ]);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.refresh_reuse_detected',
          failureReason: 'refresh token reuse (concurrent)',
        }),
      );
    });
  });
});
