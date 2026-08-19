import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient, withTenant as scopedTx } from '@wea/db';
import { totpCode, stepFor, hashPassword, TOTP_STEP_SECONDS } from '@wea/crypto';
import { SessionService } from '../src/auth/session.service.js';
import { TwoFactorService } from '../src/auth/two-factor.service.js';

/**
 * The second factor, against a real database.
 *
 * Two failures are worse than having no second factor at all, and both are the
 * reason this exists rather than a mock: enabling it on a secret the user never
 * successfully used locks them out permanently, and a code that stays valid for
 * the rest of its thirty-second window is not one-time. Both are properties of
 * stored state, so they are checked against stored state.
 */

const url = process.env.TEST_DATABASE_URL;
const describeIfDb = url ? describe : describe.skip;

const PASSWORD = 'correct horse battery staple';

describeIfDb('two-factor authentication (real database)', () => {
  let prisma: PrismaClient;
  let sessions: SessionService;
  let twoFactor: TwoFactorService;
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const userId = randomUUID();
  const ctx = { userAgent: 'vitest', ipAddress: '127.0.0.1' };

  const user = () => prisma.user.findUnique({ where: { id: userId } });

  /** Runs setup and returns the secret an authenticator app would hold. */
  const enrol = async () => (await twoFactor.beginEnrolment(userId)).secret;

  /**
   * Setup, confirm, and hand back both halves.
   *
   * Confirms with the *previous* step's code — still inside the ±1 window, and
   * accepted — so the current step is left unspent and a test can go on to use
   * a genuine "now" code. Reusing the enrolment code would be caught by the
   * replay guard, which is the correct behaviour and not what most of these
   * tests are about.
   */
  const enable = async () => {
    const secret = await enrol();
    const previous = new Date(Date.now() - TOTP_STEP_SECONDS * 1000);
    const { recoveryCodes } = await twoFactor.confirmEnrolment(userId, totpCode(secret, previous));
    return { secret, recoveryCodes };
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const service = Object.assign(prisma, {
      forUser: <T>(id: string, fn: (tx: never) => Promise<T>) => scopedTx(prisma, id, fn as never),
    });

    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sessions = new SessionService(service as never, logger as never);
    twoFactor = new TwoFactorService(
      service as never,
      {
        env: {
          KMS_PROVIDER: 'local',
          ENCRYPTION_MASTER_KEY: randomBytes(32).toString('base64'),
        },
      } as never,
      sessions,
      logger as never,
    );

    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId.slice(0, 8)}@example.com`,
        status: 'active',
        passwordHash: await hashPassword(PASSWORD),
      },
    });
  });

  beforeEach(async () => {
    await prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecretCipher: null,
        twoFactorSecretDek: null,
        twoFactorSecretKeyVer: null,
        twoFactorRecoveryCodes: [],
        twoFactorLastUsedStep: null,
        twoFactorConfirmedAt: null,
      },
    });
    await scopedTx(prisma, userId, (tx) =>
      (tx as unknown as PrismaClient).session.deleteMany({ where: { userId } }),
    );
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe('enrolment', () => {
    it('stores a secret without enabling anything', async () => {
      // The failure this ordering exists to prevent: enabling on a secret the
      // user never proved they hold locks them out at the next sign-in.
      await enrol();

      const stored = await user();
      expect(stored!.twoFactorSecretCipher).not.toBeNull();
      expect(stored!.twoFactorEnabled).toBe(false);
      expect(stored!.twoFactorConfirmedAt).toBeNull();
    });

    it('never stores the secret in the clear', async () => {
      const secret = await enrol();
      const stored = await user();

      expect(Buffer.from(stored!.twoFactorSecretCipher!).toString('utf8')).not.toContain(secret);
    });

    it('hands back a URI an authenticator app can scan', async () => {
      const challenge = await twoFactor.beginEnrolment(userId);
      expect(challenge.otpauthUri).toContain('otpauth://totp/');
      expect(challenge.otpauthUri).toContain(challenge.secret);
    });

    it('refuses to enable on a wrong code', async () => {
      await enrol();

      await expect(twoFactor.confirmEnrolment(userId, '000000')).rejects.toThrow();
      expect((await user())!.twoFactorEnabled).toBe(false);
    });

    it('enables once a working code is produced', async () => {
      const secret = await enrol();
      await twoFactor.confirmEnrolment(userId, totpCode(secret));

      const stored = await user();
      expect(stored!.twoFactorEnabled).toBe(true);
      expect(stored!.twoFactorConfirmedAt).not.toBeNull();
    });

    it('issues recovery codes, stored only as hashes', async () => {
      // Without these, losing a phone means losing the mailbox.
      const { recoveryCodes } = await enable();
      const stored = await user();

      expect(recoveryCodes.length).toBeGreaterThanOrEqual(8);
      expect(stored!.twoFactorRecoveryCodes).toHaveLength(recoveryCodes.length);
      for (const code of recoveryCodes) {
        expect(stored!.twoFactorRecoveryCodes).not.toContain(code);
      }
    });

    it('lets an abandoned enrolment be restarted', async () => {
      const first = await enrol();
      const second = await enrol();

      expect(second).not.toBe(first);
      // And the old secret is genuinely dead, not merely superseded in the UI.
      await expect(twoFactor.confirmEnrolment(userId, totpCode(first))).rejects.toThrow();
    });

    it('refuses to re-enrol over a working second factor', async () => {
      // Silently rotating a confirmed secret would lock the user out of their
      // own account.
      await enable();
      await expect(twoFactor.beginEnrolment(userId)).rejects.toThrow();
    });

    it('refuses to confirm when enrolment was never started', async () => {
      await expect(twoFactor.confirmEnrolment(userId, '123456')).rejects.toThrow();
    });
  });

  describe('verifying a session', () => {
    it('marks the session, not the user', async () => {
      // Verifying on a laptop must not authorize a session someone else opened
      // with a stolen password.
      const { secret } = await enable();
      const mine = await sessions.create(userId, ctx);
      const theirs = await sessions.create(userId, ctx);

      await twoFactor.verifyForSession(userId, mine.sessionId, totpCode(secret));

      const rows = await scopedTx(prisma, userId, (tx) =>
        (tx as unknown as PrismaClient).session.findMany({ where: { userId } }),
      );
      const byId = new Map(rows.map((r) => [r.id, r.mfaSatisfiedAt]));

      expect(byId.get(mine.sessionId)).not.toBeNull();
      expect(byId.get(theirs.sessionId)).toBeNull();
    });

    it('refuses a replayed code', async () => {
      // A TOTP code stays arithmetically valid for its whole window, so without
      // the spent-step guard "one-time" is not true.
      const { secret } = await enable();
      const session = await sessions.create(userId, ctx);
      const code = totpCode(secret);

      await twoFactor.verifyForSession(userId, session.sessionId, code);

      await expect(twoFactor.verifyForSession(userId, session.sessionId, code)).rejects.toThrow();
    });

    it('records the spent step so the guard survives a restart', async () => {
      const { secret } = await enable();
      const session = await sessions.create(userId, ctx);

      await twoFactor.verifyForSession(userId, session.sessionId, totpCode(secret));

      expect(Number((await user())!.twoFactorLastUsedStep)).toBe(stepFor(new Date()));
    });

    it('accepts the next code', async () => {
      const { secret } = await enable();
      const session = await sessions.create(userId, ctx);
      await twoFactor.verifyForSession(userId, session.sessionId, totpCode(secret));

      const later = new Date(Date.now() + TOTP_STEP_SECONDS * 1000);
      await expect(
        twoFactor.verifyForSession(userId, session.sessionId, totpCode(secret, later)),
      ).resolves.toMatchObject({ usedRecoveryCode: false });
    });

    it('refuses a wrong code', async () => {
      const { secret } = await enable();
      const session = await sessions.create(userId, ctx);
      const wrong = totpCode(secret) === '000000' ? '111111' : '000000';

      await expect(twoFactor.verifyForSession(userId, session.sessionId, wrong)).rejects.toThrow();
    });

    it('refuses when two-factor is not enabled', async () => {
      await enrol();
      const session = await sessions.create(userId, ctx);

      await expect(
        twoFactor.verifyForSession(userId, session.sessionId, '123456'),
      ).rejects.toThrow();
    });
  });

  describe('recovery codes', () => {
    it('let someone in without their authenticator', async () => {
      const { recoveryCodes } = await enable();
      const session = await sessions.create(userId, ctx);

      const result = await twoFactor.verifyForSession(userId, session.sessionId, recoveryCodes[0]!);

      expect(result.usedRecoveryCode).toBe(true);
      expect(result.recoveryCodesRemaining).toBe(recoveryCodes.length - 1);
    });

    it('are spent on use', async () => {
      const { recoveryCodes } = await enable();
      const session = await sessions.create(userId, ctx);

      await twoFactor.verifyForSession(userId, session.sessionId, recoveryCodes[0]!);

      await expect(
        twoFactor.verifyForSession(userId, session.sessionId, recoveryCodes[0]!),
      ).rejects.toThrow();
    });

    it('do not consume each other', async () => {
      const { recoveryCodes } = await enable();
      const session = await sessions.create(userId, ctx);

      await twoFactor.verifyForSession(userId, session.sessionId, recoveryCodes[0]!);
      await expect(
        twoFactor.verifyForSession(userId, session.sessionId, recoveryCodes[1]!),
      ).resolves.toMatchObject({ usedRecoveryCode: true });
    });

    it('do not get spent by a mistyped TOTP code', async () => {
      // Order matters in the verifier: attempting recovery first would burn a
      // code on what was really a fat-fingered authenticator entry.
      const { recoveryCodes } = await enable();
      const session = await sessions.create(userId, ctx);

      await twoFactor.verifyForSession(userId, session.sessionId, '000000').catch(() => undefined);

      expect((await user())!.twoFactorRecoveryCodes).toHaveLength(recoveryCodes.length);
    });
  });

  describe('carrying the factor across a refresh', () => {
    it('survives rotation', async () => {
      // Otherwise the user is asked for a code every fifteen minutes forever,
      // which is how people turn 2FA off.
      const { secret } = await enable();
      const session = await sessions.create(userId, ctx);
      await twoFactor.verifyForSession(userId, session.sessionId, totpCode(secret));

      const rotated = await sessions.rotate(session.refreshToken, ctx);

      expect(rotated.mfaSatisfiedAt).not.toBeNull();
    });

    it('does not appear on a session that never verified', async () => {
      await enable();
      const session = await sessions.create(userId, ctx);

      const rotated = await sessions.rotate(session.refreshToken, ctx);

      expect(rotated.mfaSatisfiedAt).toBeNull();
    });
  });

  describe('turning it off', () => {
    it('requires the password', async () => {
      const { secret } = await enable();

      await expect(twoFactor.disable(userId, 'wrong password', totpCode(secret))).rejects.toThrow();
      expect((await user())!.twoFactorEnabled).toBe(true);
    });

    it('requires a current code as well', async () => {
      await enable();

      await expect(twoFactor.disable(userId, PASSWORD, '000000')).rejects.toThrow();
      expect((await user())!.twoFactorEnabled).toBe(true);
    });

    it('clears the secret and the recovery codes', async () => {
      const { secret } = await enable();

      await twoFactor.disable(userId, PASSWORD, totpCode(secret));

      const stored = await user();
      expect(stored!.twoFactorEnabled).toBe(false);
      expect(stored!.twoFactorSecretCipher).toBeNull();
      expect(stored!.twoFactorRecoveryCodes).toEqual([]);
    });

    it('accepts a recovery code, for someone whose phone is gone', async () => {
      const { recoveryCodes } = await enable();

      await twoFactor.disable(userId, PASSWORD, recoveryCodes[0]!);

      expect((await user())!.twoFactorEnabled).toBe(false);
    });

    it('revokes every session', async () => {
      // Whoever asked can sign in again; anyone else is removed.
      const { secret } = await enable();
      await sessions.create(userId, ctx);
      await sessions.create(userId, ctx);

      await twoFactor.disable(userId, PASSWORD, totpCode(secret));

      const active = await scopedTx(prisma, userId, (tx) =>
        (tx as unknown as PrismaClient).session.count({ where: { revokedAt: null } }),
      );
      expect(active).toBe(0);
    });
  });
});
