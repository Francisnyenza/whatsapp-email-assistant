import { Controller, Post, Get, Body, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@wea/shared';
import { AuthService, type AuthResult } from './auth.service.js';
import { SessionService } from './session.service.js';
import { TwoFactorService } from './two-factor.service.js';
import { PhoneVerificationService } from './phone-verification.service.js';
import { ConfigService } from '../config/config.service.js';
import { AuthGuard } from './auth.guard.js';
import { MfaGuard } from './mfa.guard.js';

/**
 * Authentication endpoints.
 *
 * Refresh tokens are returned in the body rather than set as cookies, because
 * the mobile app is a first-class client and cannot use them. That puts the
 * storage decision on the client, which is the right place for it — but it does
 * mean the web app must keep the refresh token out of localStorage.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
    private readonly phone: PhoneVerificationService,
    private readonly config: ConfigService,
  ) {}

  @Post('signup')
  signUp(@Req() req: Request, @Body() body: unknown): Promise<AuthResult> {
    const input = requireCredentials(body);
    return this.auth.signUp({
      ...input,
      ...(typeof (body as { fullName?: unknown }).fullName === 'string'
        ? { fullName: (body as { fullName: string }).fullName }
        : {}),
      context: clientContext(req),
    });
  }

  @Post('signin')
  @HttpCode(HttpStatus.OK)
  signIn(@Req() req: Request, @Body() body: unknown): Promise<AuthResult> {
    const input = requireCredentials(body);
    return this.auth.signIn({ ...input, context: clientContext(req) });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Req() req: Request, @Body() body: unknown): Promise<AuthResult> {
    const token = (body as { refreshToken?: unknown })?.refreshToken;
    if (typeof token !== 'string' || !token) {
      throw new AppError('BAD_REQUEST', 'refreshToken is required', {
        publicMessage: 'Please sign in again.',
      });
    }
    return this.auth.refresh(token, clientContext(req));
  }

  @Post('signout')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@Req() req: Request, @Body() body: unknown): Promise<void> {
    const token = (body as { refreshToken?: unknown })?.refreshToken;
    if (typeof token === 'string' && token) {
      await this.auth.signOut(req.user!.id, token);
    }
  }

  /** Signs out everywhere — the button someone presses after losing a phone. */
  @Post('signout-all')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOutEverywhere(@Req() req: Request): Promise<void> {
    // Revoking one family would leave sessions from other logins alive, so this
    // revokes every family and bumps tokensValidFrom.
    await this.sessions.revokeAll(req.user!.id, 'user signed out everywhere');
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: Request): { id: string; mfaSatisfied: boolean } {
    return { id: req.user!.id, mfaSatisfied: req.user!.mfaSatisfied };
  }

  @Get('sessions')
  @UseGuards(AuthGuard)
  listSessions(@Req() req: Request) {
    return this.sessions.listActive(req.user!.id);
  }

  /* ----------------------------- two-factor ------------------------------ */

  /**
   * Step one of enrolment. Mints a secret; enables nothing.
   *
   * Requires only `AuthGuard`, not `MfaGuard` — a user who has not enrolled
   * obviously cannot have satisfied a second factor, and requiring one here
   * would make enrolment impossible.
   */
  @Post('2fa/setup')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  beginTwoFactor(@Req() req: Request) {
    return this.twoFactor.beginEnrolment(req.user!.id);
  }

  /**
   * Step two: prove the code works, and only then turn it on.
   *
   * Returns the recovery codes, once. They are stored as hashes, so this is the
   * only moment they exist in readable form.
   */
  @Post('2fa/enable')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async enableTwoFactor(@Req() req: Request, @Body() body: unknown) {
    const result = await this.twoFactor.confirmEnrolment(
      req.user!.id,
      requireCode(body),
      req.user!.sessionId,
    );

    // A token that reflects the factor they just satisfied. Without it the
    // client holds one saying `mfa: false` and is locked out of everything it
    // just switched on.
    return { ...result, ...(await this.auth.reissueForSession(req.user!.id, req.user!.sessionId)) };
  }

  /**
   * Satisfies the second factor for the current session.
   *
   * Guarded by `AuthGuard` alone, deliberately: this is the endpoint a user
   * reaches holding a token that says `mfa: false`, and requiring `MfaGuard`
   * here would be a locked door whose key is behind it.
   */
  @Post('2fa/verify')
  @UseGuards(AuthGuard)
  @HttpCode(HttpStatus.OK)
  async verifyTwoFactor(@Req() req: Request, @Body() body: unknown) {
    const result = await this.twoFactor.verifyForSession(
      req.user!.id,
      req.user!.sessionId,
      requireCode(body),
    );

    // A fresh access token, because the old one still says mfa: false and the
    // client has nothing else to present.
    return { ...result, ...(await this.auth.reissueForSession(req.user!.id, req.user!.sessionId)) };
  }

  /**
   * Turns it off. Requires the password *and* a current code.
   *
   * `MfaGuard` as well, so a session that never satisfied the second factor
   * cannot remove it — otherwise a stolen password alone would be enough to
   * strip the thing keeping the attacker out.
   */
  @Post('2fa/disable')
  @UseGuards(AuthGuard, MfaGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async disableTwoFactor(@Req() req: Request, @Body() body: unknown): Promise<void> {
    const password = (body as { password?: unknown })?.password;
    if (typeof password !== 'string' || !password) {
      throw new AppError('VALIDATION_FAILED', 'password is required', {
        publicMessage: 'Enter your password to turn off two-factor authentication.',
      });
    }

    await this.twoFactor.disable(req.user!.id, password, requireCode(body));
  }

  /* ---------------------------- phone number ---------------------------- */

  /**
   * Where the settings screen finds out whether a number is linked.
   */
  @Get('phone')
  @UseGuards(AuthGuard)
  phoneStatus(@Req() req: Request) {
    return this.phone.status(req.user!.id);
  }

  /**
   * Issues a code for the user to send us from the phone they are claiming.
   *
   * The code comes back in plaintext exactly once, to the authenticated user who
   * asked for it. Verification then runs *inbound*: they send it to our WhatsApp
   * number, which proves possession without an approved template and opens the
   * 24-hour messaging window the first notification needs anyway.
   *
   * Behind the MFA guard as well as the auth guard. Linking a phone redirects
   * where this account's mail is delivered, which puts it in the same class as
   * changing a password — a stolen access token alone must not be enough.
   */
  @Post('phone/start')
  @UseGuards(AuthGuard, MfaGuard)
  async startPhoneVerification(@Req() req: Request) {
    const { code, expiresAt } = await this.phone.start(req.user!.id);

    return {
      code,
      expiresAt,
      // The number to send it *to*, so the caller does not have to know it.
      sendTo: this.config.env.WHATSAPP_BUSINESS_NUMBER ?? null,
    };
  }

  /** Unlinks the number, so notifications stop and it can be claimed elsewhere. */
  @Post('phone/unlink')
  @UseGuards(AuthGuard, MfaGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkPhone(@Req() req: Request): Promise<void> {
    await this.phone.unlink(req.user!.id);
  }
}

/**
 * A code is a string of digits or a recovery code, and both are short. Anything
 * long enough to be interesting is rejected before it reaches a comparison.
 */
function requireCode(body: unknown): string {
  const code = (body as { code?: unknown })?.code;

  if (typeof code !== 'string' || !code.trim() || code.length > 64) {
    throw new AppError('VALIDATION_FAILED', 'code is required', {
      publicMessage: 'Enter the code from your authenticator app.',
    });
  }
  return code.trim();
}

function requireCredentials(body: unknown): { email: string; password: string } {
  const email = (body as { email?: unknown })?.email;
  const password = (body as { password?: unknown })?.password;

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new AppError('VALIDATION_FAILED', 'Email and password are required', {
      publicMessage: 'Please enter your email and password.',
    });
  }
  return { email, password };
}

/**
 * Where the request came from, for the active-sessions list.
 *
 * `x-forwarded-for` is only trustworthy behind our own proxy; it is recorded for
 * display and never used for an access decision.
 */
function clientContext(req: Request): { userAgent?: string; ipAddress?: string } {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();

  return {
    ...(req.headers['user-agent']
      ? { userAgent: String(req.headers['user-agent']).slice(0, 300) }
      : {}),
    ...(ip || req.ip ? { ipAddress: (ip ?? req.ip)!.slice(0, 45) } : {}),
  };
}
