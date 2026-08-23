import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';

/**
 * Access tokens.
 *
 * Short-lived and stateless: verifying one must not touch the database, because
 * it happens on every single request. The trade is that revocation is not
 * instant — a token stays valid until it expires.
 *
 * `tokensValidFrom` is the answer to that. It is checked against the token's
 * issue time on sensitive operations, so a password change or a forced sign-out
 * invalidates every outstanding token without a blacklist.
 */
export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  sid: string;
  /** Whether two-factor has been satisfied for this session. */
  mfa: boolean;
}

@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.secret = new TextEncoder().encode(config.env.JWT_ACCESS_SECRET);
    this.ttlSeconds = parseTtl(config.env.JWT_ACCESS_TTL);
  }

  async sign(input: { userId: string; sessionId: string; mfaSatisfied: boolean }): Promise<string> {
    return new SignJWT({ sid: input.sessionId, mfa: input.mfaSatisfied })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.userId)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setIssuer('wea')
      .setAudience('wea-api')
      .sign(this.secret);
  }

  /**
   * Verifies an access token.
   *
   * `jwtVerify` checks the signature, expiry, issuer and audience. Pinning the
   * algorithm matters: without it, a token with `alg: none` — or one signed with
   * the public half of an asymmetric pair — can be accepted.
   */
  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: 'wea',
        audience: 'wea-api',
      });

      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new AppError('UNAUTHENTICATED', 'Access token is missing required claims');
      }

      return payload as AccessTokenClaims;
    } catch (err) {
      if (AppError.isAppError(err)) throw err;
      // One message for expired, malformed and forged alike.
      throw new AppError('UNAUTHENTICATED', 'Access token rejected', {
        publicMessage: 'Please sign in to continue.',
        retryable: false,
        cause: err,
      });
    }
  }

  get accessTtlSeconds(): number {
    return this.ttlSeconds;
  }
}

/** Parses `15m`, `1h`, `30s`, or a bare number of seconds. */
export function parseTtl(value: string): number {
  const match = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!match) return 900;

  const amount = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return amount * 86_400;
    case 'h':
      return amount * 3_600;
    case 'm':
      return amount * 60;
    default:
      return amount;
  }
}
