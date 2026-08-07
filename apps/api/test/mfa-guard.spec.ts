import { describe, it, expect } from 'vitest';
import { MfaGuard } from '../src/auth/mfa.guard.js';

/**
 * The guard that makes the `mfa` claim mean something.
 *
 * Without it the claim is decoration: a token can say `mfa: false` and still
 * reach everything, which is what a complete enrolment flow protecting nothing
 * looks like.
 */

const guard = new MfaGuard();

const context = (user?: { id: string; sessionId: string; mfaSatisfied: boolean }) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;

const verified = { id: 'user-1', sessionId: 'session-1', mfaSatisfied: true };
const unverified = { ...verified, mfaSatisfied: false };

it('lets a verified session through', () => {
  expect(guard.canActivate(context(verified))).toBe(true);
});

it('refuses a session that has not satisfied the second factor', () => {
  expect(() => guard.canActivate(context(unverified))).toThrow();
});

it('refuses distinguishably, so the client asks for a code and not a password', () => {
  // A client that cannot tell "sign in" from "you are signed in, now enter your
  // code" sends the user back to a login form they have already completed.
  try {
    guard.canActivate(context(unverified));
    expect.unreachable();
  } catch (err) {
    expect((err as { code: string }).code).toBe('TWO_FACTOR_REQUIRED');
  }
});

it('refuses when used without AuthGuard ahead of it', () => {
  // `mfaSatisfied` on an absent user is undefined, so a guard that only checked
  // truthiness would let an unauthenticated request through.
  try {
    guard.canActivate(context(undefined));
    expect.unreachable();
  } catch (err) {
    expect((err as { code: string }).code).toBe('UNAUTHENTICATED');
  }
});
