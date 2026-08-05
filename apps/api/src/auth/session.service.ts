import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError } from '@wea/shared';
import { generateToken, hashToken } from '@wea/crypto';
import type { Logger } from 'pino';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Refresh tokens, and detecting when one has been stolen.
 *
 * Refresh tokens are long-lived bearer credentials, which makes theft the
 * failure that matters. We cannot prevent it — a token exfiltrated from a
 * device is indistinguishable from the real one — but we can make it *loud*.
 *
 * The mechanism is rotation with reuse detection:
 *
 *  * every refresh issues a new token and invalidates the one presented;
 *  * tokens issued from one login share a `familyId`;
 *  * presenting a token that has *already been rotated* is impossible for a
 *    legitimate client, because it discarded that token on receiving its
 *    replacement. So it means two parties hold the same token — a theft.
 *
 * The response to detection is deliberately drastic: the whole family is
 * revoked, logging out the attacker *and* the real user. That is the right
 * trade. The user re-authenticates once and is safe; leaving the family alive
 * because we cannot tell which party is legitimate would keep the attacker in.
 */

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  familyId: string;
  expiresAt: Date;
}

/** 30 days. Long enough that a phone is not constantly signing in. */
const REFRESH_TTL_MS = 30 * 24 * 3_600_000;

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /** Starts a new session family — one login. */
  async create(
    userId: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<IssuedSession> {
    const familyId = randomUUID();
    return this.issue(userId, familyId, context);
  }

  /**
   * Rotates a refresh token.
   *
   * @throws {AppError} when the token is unknown, expired, revoked, or has
   *   already been rotated. The last case revokes the entire family first.
   */
  async rotate(
    presentedToken: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<IssuedSession> {
    const tokenHash = hashToken(presentedToken);

    // Unscoped: we do not yet know whose token this is, and the hash is the
    // only lookup key. It reads one indexed row.
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        replacedById: true,
      },
    });

    if (!session) {
      // Never existed, or was cleaned up. Nothing to revoke.
      throw this.rejected('unknown refresh token');
    }

    // --- the theft signal ---------------------------------------------------
    // A legitimate client discards a token the moment it receives a
    // replacement, so presenting a rotated token means two parties hold it.
    if (session.replacedById || session.revokedAt) {
      await this.revokeFamily(session.userId, session.familyId, 'refresh token reuse');

      this.logger.error(
        {
          event: 'auth.refresh_reuse_detected',
          userId: session.userId,
          familyId: session.familyId,
        },
        'Refresh token reuse detected — revoking the entire session family',
      );

      throw this.rejected('refresh token reuse');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw this.rejected('expired refresh token');
    }

    const issued = await this.issue(session.userId, session.familyId, context);

    // Mark the presented token as rotated. Doing this *after* issuing means a
    // crash between the two leaves the old token valid — an inconvenience —
    // rather than logging the user out with no replacement.
    await this.prisma.forUser(session.userId, async (tx) => {
      await tx.session.update({
        where: { id: session.id },
        data: { replacedById: issued.sessionId, lastUsedAt: new Date() },
      });
    });

    return issued;
  }

  /** Signs out one session. */
  async revoke(userId: string, refreshToken: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.session.updateMany({
        where: { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /**
   * Signs out every session in a family.
   *
   * Used on reuse detection and on an explicit "sign out everywhere".
   */
  async revokeFamily(userId: string, familyId: string, reason: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.session.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    this.logger.info({ event: 'auth.family_revoked', userId, familyId, reason });
  }

  /** Signs out every session for a user, across all families. */
  async revokeAll(userId: string, reason: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.session.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
    });

    // Also invalidates every outstanding access token, which the stateless
    // verifier cannot revoke on its own.
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokensValidFrom: new Date() },
    });

    this.logger.info({ event: 'auth.all_sessions_revoked', userId, reason });
  }

  /** Every live session, for the "where you're signed in" screen. */
  async listActive(userId: string) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.session.findMany({
        where: { revokedAt: null, replacedById: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        // Deliberately not selecting refreshTokenHash — nothing outside this
        // service has any use for it.
        select: {
          id: true,
          userAgent: true,
          ipAddress: true,
          location: true,
          createdAt: true,
          lastUsedAt: true,
        },
      }),
    );
  }

  private async issue(
    userId: string,
    familyId: string,
    context: { userAgent?: string; ipAddress?: string },
  ): Promise<IssuedSession> {
    const { token, hash } = generateToken('wea_rt');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    const session = await this.prisma.forUser(userId, async (tx) =>
      tx.session.create({
        data: {
          userId,
          familyId,
          refreshTokenHash: hash,
          expiresAt,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
        select: { id: true },
      }),
    );

    return { sessionId: session.id, refreshToken: token, familyId, expiresAt };
  }

  /**
   * One error for every rejection.
   *
   * Distinguishing "unknown" from "expired" from "reused" tells an attacker
   * whether a token they hold was ever real.
   */
  private rejected(reason: string): AppError {
    return new AppError('UNAUTHENTICATED', `Refresh rejected: ${reason}`, {
      publicMessage: 'Your session has expired. Please sign in again.',
      retryable: false,
    });
  }
}
