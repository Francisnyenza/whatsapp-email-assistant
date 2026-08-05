import { Controller, Post, Get, Body, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@wea/shared';
import { AuthService, type AuthResult } from './auth.service.js';
import { SessionService } from './session.service.js';
import { AuthGuard } from './auth.guard.js';

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
  ) {}

  @Post('signup')
  signUp(@Req() req: Request, @Body() body: unknown): Promise<AuthResult> {
    const input = requireCredentials(body);
    return this.auth.signUp({
      ...input,
      ...(typeof (body as { fullName?: unknown }).fullName === 'string'
        ? { fullName: (body as { fullName: string }).fullName }
        : {}),
      ...(typeof (body as { phoneNumber?: unknown }).phoneNumber === 'string'
        ? { phoneNumber: (body as { phoneNumber: string }).phoneNumber }
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
