import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@wea/shared';

/**
 * Requires that the second factor has actually been satisfied.
 *
 * Stacked after `AuthGuard`, never instead of it: this reads `req.user`, which
 * only exists once a token has been verified. Used alone it would let an
 * unauthenticated request through, because `mfaSatisfied` on an absent user is
 * simply undefined.
 *
 * Without this guard the `mfa` claim is decoration — a token can say
 * `mfa: false` and still reach everything. That was the state of the code
 * before: a complete enrolment flow protecting nothing.
 *
 * The rejection is deliberately distinguishable from an ordinary
 * authentication failure. A client that cannot tell "sign in" from "you are
 * signed in, now enter your code" will send the user back to a login form they
 * have already completed.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (!req.user) {
      throw new AppError('UNAUTHENTICATED', 'MfaGuard used without AuthGuard', {
        publicMessage: 'Please sign in to continue.',
      });
    }

    if (!req.user.mfaSatisfied) {
      throw new AppError('TWO_FACTOR_REQUIRED', 'Second factor not satisfied', {
        publicMessage: 'Enter the code from your authenticator app to continue.',
      });
    }

    return true;
  }
}
