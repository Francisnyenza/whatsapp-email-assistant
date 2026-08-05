import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@wea/shared';
import { TokenService } from './token.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by AuthGuard. Absent means unauthenticated. */
    user?: { id: string; sessionId: string; mfaSatisfied: boolean };
  }
}

/**
 * Requires a valid access token.
 *
 * Fails closed in every direction: a missing header, a malformed one, a bad
 * signature and an expired token all produce the same rejection. Nothing
 * downstream ever has to check whether `req.user` is trustworthy — if the
 * handler runs, it is.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'Missing bearer token', {
        publicMessage: 'Please sign in to continue.',
      });
    }

    const claims = await this.tokens.verify(header.slice(7).trim());

    req.user = { id: claims.sub, sessionId: claims.sid, mfaSatisfied: claims.mfa === true };
    return true;
  }
}
