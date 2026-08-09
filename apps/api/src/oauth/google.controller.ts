import { Controller, Get, Query, Req, Res, Inject, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { AppError } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
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
   * The consent URL for this user.
   *
   * Returns it as JSON rather than redirecting, and that is the whole reason
   * this endpoint can be guarded at all. A browser navigating here directly
   * cannot send an `Authorization` header, so a redirect endpoint is either
   * unauthenticated — which would let anyone start a flow that attaches a
   * mailbox to someone else's account — or authenticated and unreachable. The
   * caller navigates to what comes back.
   *
   * The user id comes from the verified token, never from the query.
   */
  @Get('start')
  @UseGuards(AuthGuard)
  start(@Req() req: Request, @Query('returnTo') returnTo?: string): { url: string } {
    const state = createOAuthState(
      { userId: req.user!.id, provider: 'google', ...(returnTo ? { returnTo } : {}) },
      this.config.env.JWT_ACCESS_SECRET,
    );

    return { url: this.linking.consentUrl(state) };
  }

  /**
   * Handles Google's redirect back.
   *
   * Deliberately unguarded, and it has to be: Google redirects a browser here,
   * which carries no bearer token. Identity comes from the signed `state`
   * instead — which is exactly what `state` is for, and why it is signed rather
   * than being an opaque blob looked up in a session that a load balancer could
   * have moved.
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
