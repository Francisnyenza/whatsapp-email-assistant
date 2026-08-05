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
    sessions = new SessionService(service as never, logger as never);

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
});
