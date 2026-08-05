import { Controller, Get, Query, Req, Res, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { AppError } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { AccountLinkingService } from './account-linking.service.js';
import { createOAuthState, verifyOAuthState, safeReturnPath } from './oauth-state.js';

/**
 * Connecting a Gmail mailbox.
 *
 * Two endpoints, and the security of both rests on `state`: it carries who is
 * connecting, signed, so the callback never has to infer identity from a
 * session that an attacker could have supplied.
 */
@Controller('v1/oauth/google')
export class GoogleOAuthController {
  constructor(
    private readonly config: ConfigService,
    private readonly linking: AccountLinkingService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Redirects to Google's consent screen.
   *
   * The user id comes from the authenticated session, not from the query — a
   * `userId` parameter here would let anyone start a flow that attaches a
   * mailbox to someone else's account.
   */
  @Get('start')
  start(@Req() req: Request, @Res() res: Response, @Query('returnTo') returnTo?: string): void {
    const userId = currentUserId(req);

    const state = createOAuthState(
      { userId, provider: 'google', ...(returnTo ? { returnTo } : {}) },
      this.config.env.JWT_ACCESS_SECRET,
    );

    res.redirect(this.linking.consentUrl(state));
  }

  /**
   * Handles Google's redirect back.
   *
   * Everything here arrives from a third party via the user's browser, so
   * nothing is trusted until `state` verifies.
   */
  @Get('callback')
  async callback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') rawState?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    // The user declined, or Google refused. Not an error on our side — take
    // them back rather than showing a failure page.
    if (error) {
      this.logger.info({ event: 'oauth.declined', provider: 'google', reason: error });
      res.redirect(`${this.config.env.WEB_BASE_URL}/settings/accounts?connect=cancelled`);
      return;
    }

    const state = verifyOAuthState(rawState, this.config.env.JWT_ACCESS_SECRET);

    if (!code) {
      throw new AppError('BAD_REQUEST', 'Google returned no authorization code', {
        publicMessage: 'That connection did not complete. Please try again.',
      });
    }

    const { accountId, emailAddress } = await this.linking.completeGoogleLink(state.userId, code);

    // Watching is best-effort: a mailbox that is connected but not yet watched
    // still works through the polling fallback.
    const watching = await this.linking.startWatching(state.userId, accountId);

    this.logger.info(
      { event: 'oauth.completed', provider: 'google', accountId, watching },
      'Mailbox connected',
    );

    const destination = safeReturnPath(state.returnTo);
    const query = new URLSearchParams({
      connect: 'success',
      account: emailAddress,
      ...(watching ? {} : { mode: 'polling' }),
    });

    res.redirect(`${this.config.env.WEB_BASE_URL}${destination}?${query.toString()}`);
  }
}

/**
 * The authenticated user.
 *
 * The auth guard is not built yet, so this reads the header a future guard will
 * populate and refuses when it is absent. It fails closed: without a verified
 * identity there is nobody to attach a mailbox to, and guessing would be the
 * exact vulnerability `state` exists to prevent.
 */
function currentUserId(req: Request): string {
  const userId = (req as { user?: { id?: string } }).user?.id;

  if (!userId) {
    throw new AppError('UNAUTHENTICATED', 'OAuth flow started without an authenticated user', {
      publicMessage: 'Please sign in before connecting a mailbox.',
    });
  }
  return userId;
}
