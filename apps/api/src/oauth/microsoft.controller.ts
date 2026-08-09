import { Controller, Get, Query, Req, Res, Inject, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { AppError } from '@wea/shared';
import { ConfigService } from '../config/config.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AccountLinkingService } from './account-linking.service.js';
import { createOAuthState, verifyOAuthState, safeReturnPath } from './oauth-state.js';

/**
 * Connecting an Outlook or Microsoft 365 mailbox.
 *
 * The same two endpoints as Google's, and deliberately the same shape: the
 * security of both rests on `state`, which carries who is connecting, signed, so
 * the callback never infers identity from anything the browser supplied.
 *
 * What differs is only what a reader would expect to differ — the consent URL
 * and the code exchange — and both of those live in the adapter.
 */
@Controller('v1/oauth/microsoft')
export class MicrosoftOAuthController {
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
      { userId: req.user!.id, provider: 'microsoft', ...(returnTo ? { returnTo } : {}) },
      this.config.env.JWT_ACCESS_SECRET,
    );

    return { url: this.linking.microsoftConsentUrl(state) };
  }

  /**
   * Handles Microsoft's redirect back.
   *
   * Deliberately unguarded, and it has to be: Microsoft redirects a browser here,
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
    // The user declined, or Microsoft refused — commonly an admin-consent
    // policy on a work tenant. Not an error on our side.
    if (error) {
      this.logger.info({ event: 'oauth.declined', provider: 'microsoft', reason: error });
      res.redirect(`${this.config.env.WEB_BASE_URL}/settings/accounts?connect=cancelled`);
      return;
    }

    const state = verifyOAuthState(rawState, this.config.env.JWT_ACCESS_SECRET);

    if (!code) {
      throw new AppError('BAD_REQUEST', 'Microsoft returned no authorization code', {
        publicMessage: 'That connection did not complete. Please try again.',
      });
    }

    const { accountId, emailAddress } = await this.linking.completeMicrosoftLink(
      state.userId,
      code,
    );

    // Watching is best-effort. It matters more here than for Gmail: Graph
    // validates the notification URL synchronously while creating the
    // subscription, so any environment where the webhook is not publicly
    // reachable lands on polling — which works, and is worth saying rather than
    // failing the whole connection over.
    const watching = await this.linking.startWatching(state.userId, accountId);

    this.logger.info(
      { event: 'oauth.completed', provider: 'microsoft', accountId, watching },
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
