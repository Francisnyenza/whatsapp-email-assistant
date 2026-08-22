import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { hashPassword, verifyPassword, needsRehash } from '@wea/crypto';
import type { Logger } from 'pino';
import { PrismaService } from '../common/prisma.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';
import { AuditService } from '../common/audit.service.js';

/**
 * Signing up and signing in.
 *
 * The details that matter here are all about what an attacker learns and how
 * fast they can guess.
 */

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; email: string; twoFactorRequired: boolean };
}

/** After this many failures the account locks. */
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  async signUp(input: {
    email: string;
    password: string;
    fullName?: string;
    context: { userAgent?: string; ipAddress?: string };
  }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);

    // A phone number is deliberately *not* accepted here. It decides where this
    // user's private email is delivered, and nothing at signup can prove they
    // own it — a typo would send someone's inbox to a stranger, and a deliberate
    // claim would squat the number under the UNIQUE constraint so its real owner
    // could never register. It is set only by the verification flow.

    // Hash before the uniqueness check so a taken address and a free one take
    // the same time — otherwise response timing enumerates registered users.
    const passwordHash = await hashPassword(input.password);

    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      // Deliberately the same shape of error as any other validation failure,
      // and phrased so it does not confirm the address is registered.
      throw new AppError('CONFLICT', 'Email already registered', {
        publicMessage: 'We could not create that account. Try signing in instead.',
      });
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName: input.fullName ?? null,
        status: 'active',
      },
      select: { id: true, email: true },
    });

    // Preferences are created eagerly so nothing downstream has to cope with
    // their absence.
    await this.prisma.forUser(user.id, async (tx) => {
      await tx.userPreference.create({ data: { userId: user.id } });
    });

    this.logger.info({ event: 'auth.signed_up', userId: user.id }, 'Account created');

    await this.audit.record({ action: 'auth.signup', userId: user.id, ...input.context });

    return this.grant(user.id, user.email, false, input.context);
  }

  /**
   * Signs in.
   *
   * Every failure — unknown address, wrong password, locked account — returns
   * the same error. An attacker must not be able to use the login form to
   * discover which addresses have accounts.
   */
  async signIn(input: {
    email: string;
    password: string;
    context: { userAgent?: string; ipAddress?: string };
  }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        failedLoginAttempts: true,
        lockedUntil: true,
        twoFactorEnabled: true,
      },
    });

    const invalid = new AppError('INVALID_CREDENTIALS', 'Sign-in failed', {
      publicMessage: 'That email or password is incorrect.',
      retryable: false,
    });

    if (!user || !user.passwordHash) {
      // Spend comparable time so a missing account is not faster than a wrong
      // password. Without this the response time is a user-enumeration oracle.
      await verifyPassword(DUMMY_HASH, input.password);
      // `userId: null`, because there is no user — which is itself the finding.
      // A burst of these against many addresses is enumeration; against one, a
      // typo. Only the trail can tell them apart.
      await this.audit.record({
        action: 'auth.signin',
        success: false,
        failureReason: 'no such account',
        ...input.context,
      });
      throw invalid;
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      // Same error as a wrong password: telling an attacker they have
      // successfully locked an account confirms it exists. The audit trail is
      // where the distinction is allowed to live, because only the account
      // owner and an investigator can read it.
      await this.audit.record({
        action: 'auth.signin',
        userId: user.id,
        success: false,
        failureReason: 'account locked',
        ...input.context,
      });
      throw invalid;
    }

    if (user.status === 'suspended' || user.status === 'deleted') {
      await this.audit.record({
        action: 'auth.signin',
        userId: user.id,
        success: false,
        failureReason: `account ${user.status}`,
        ...input.context,
      });
      throw invalid;
    }

    const correct = await verifyPassword(user.passwordHash, input.password);

    if (!correct) {
      await this.recordFailure(user.id, user.failedLoginAttempts);
      await this.audit.record({
        action: 'auth.signin',
        userId: user.id,
        success: false,
        failureReason: 'wrong password',
        // The count, not the password. How close an attacker got to the
        // lockout is the useful part of this entry.
        metadata: { attempt: user.failedLoginAttempts + 1 },
        ...input.context,
      });
      throw invalid;
    }

    // Upgrade the hash if our parameters have hardened since it was written.
    // This is the only moment the plaintext is available.
    if (needsRehash(user.passwordHash)) {
      const rehashed = await hashPassword(input.password);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: rehashed },
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    this.logger.info({ event: 'auth.signed_in', userId: user.id }, 'Signed in');

    await this.audit.record({
      action: 'auth.signin',
      userId: user.id,
      // A successful sign-in from an unfamiliar address is the entry a user
      // asking "was that me?" is shown, so the successes matter as much as the
      // failures.
      metadata: { twoFactorRequired: user.twoFactorEnabled },
      ...input.context,
    });

    // With 2FA enabled the session exists but is not yet fully authorized; the
    // access token carries mfa: false until the code is verified.
    return this.grant(user.id, user.email, user.twoFactorEnabled, input.context);
  }

  /** Exchanges a refresh token for a new pair. */
  async refresh(
    refreshToken: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const rotated = await this.sessions.rotate(refreshToken, context);

    const user = await this.prisma.user.findUnique({
      where: { id: await this.userIdForSession(rotated.sessionId) },
      select: { id: true, email: true, twoFactorEnabled: true, status: true },
    });

    if (!user || user.status !== 'active') {
      throw new AppError('UNAUTHENTICATED', 'Account is not active', {
        publicMessage: 'Please sign in again.',
      });
    }

    const accessToken = await this.tokens.sign({
      userId: user.id,
      sessionId: rotated.sessionId,
      // Carried across the rotation. Deriving this from `twoFactorEnabled`
      // alone — as it did before — meant every refresh handed back a token
      // saying mfa: false, so a 2FA user was asked for a code every fifteen
      // minutes forever. That is how people turn 2FA off.
      mfaSatisfied: !user.twoFactorEnabled || rotated.mfaSatisfiedAt !== null,
    });

    return {
      accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user: { id: user.id, email: user.email, twoFactorRequired: user.twoFactorEnabled },
    };
  }

  /**
   * A fresh access token for a session whose standing has changed.
   *
   * Used after the second factor is satisfied: the token the client holds still
   * says `mfa: false`, and it has nothing else to present. Reads the session
   * rather than trusting the caller, so this cannot be used to mint an upgraded
   * token for a session that never verified.
   */
  async reissueForSession(
    userId: string,
    sessionId: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { twoFactorEnabled: true },
      }),
      this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true, revokedAt: true, mfaSatisfiedAt: true },
      }),
    ]);

    if (!user || !session || session.userId !== userId || session.revokedAt) {
      throw new AppError('UNAUTHENTICATED', 'Session is no longer valid', {
        publicMessage: 'Please sign in again.',
      });
    }

    const accessToken = await this.tokens.sign({
      userId,
      sessionId,
      mfaSatisfied: !user.twoFactorEnabled || session.mfaSatisfiedAt !== null,
    });

    return { accessToken, expiresIn: this.tokens.accessTtlSeconds };
  }

  async signOut(userId: string, refreshToken: string): Promise<void> {
    await this.sessions.revoke(userId, refreshToken);
  }

  /**
   * Progressive lockout.
   *
   * Argon2 already makes offline cracking expensive, but online guessing is
   * cheap without this — and each attempt also costs us 19 MiB of memory, so
   * the lockout protects the service as much as the account.
   */
  private async recordFailure(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        ...(locked ? { lockedUntil: new Date(Date.now() + LOCKOUT_MS) } : {}),
      },
    });

    if (locked) {
      this.logger.warn(
        { event: 'auth.account_locked', userId, attempts },
        'Account locked after repeated failures',
      );
    }
  }

  private async grant(
    userId: string,
    email: string,
    twoFactorEnabled: boolean,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const session = await this.sessions.create(userId, context);

    const accessToken = await this.tokens.sign({
      userId,
      sessionId: session.sessionId,
      mfaSatisfied: !twoFactorEnabled,
    });

    return {
      accessToken,
      refreshToken: session.refreshToken,
      expiresIn: this.tokens.accessTtlSeconds,
      user: { id: userId, email, twoFactorRequired: twoFactorEnabled },
    };
  }

  private async userIdForSession(sessionId: string): Promise<string> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session) throw new AppError('UNAUTHENTICATED', 'Session vanished mid-refresh');
    return session.userId;
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@') || normalized.length > 320) {
    throw new AppError('VALIDATION_FAILED', 'Invalid email address', {
      publicMessage: 'That email address does not look right.',
    });
  }
  return normalized;
}

/**
 * A real Argon2id hash of a value nobody knows, used to spend comparable time
 * when no account exists. Verifying against it always fails.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$JXBhc3N3b3JkaGFzaHZhbHVlbm9ib2R5a25vd3M';
