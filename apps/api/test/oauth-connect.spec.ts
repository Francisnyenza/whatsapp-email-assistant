import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { GoogleOAuthController } from '../src/oauth/google.controller.js';
import { MicrosoftOAuthController } from '../src/oauth/microsoft.controller.js';
import { verifyOAuthState } from '../src/oauth/oauth-state.js';

/**
 * Connecting a mailbox.
 *
 * The asymmetry between the two endpoints is the whole design and is worth
 * stating: `start` is authenticated and returns JSON, `callback` is
 * unauthenticated and trusts only the signed `state`.
 *
 * Neither could be otherwise. A browser navigating to `start` cannot send a
 * bearer token, so a redirect there would have to be unauthenticated — which
 * would let anyone begin a flow that attaches a mailbox to someone else's
 * account. And the provider redirects a browser to `callback`, which also
 * carries no token, so identity has to travel in `state`.
 *
 * That was wrong until now: `start` read a `req.user` nothing populated, so the
 * whole connect flow answered 401 forever while a comment explained that the
 * guard was not built yet. It was, and it was exported, and it was not applied.
 */

const SECRET = 'a'.repeat(48);
const USER = randomUUID();

function makeResponse() {
  const res: any = {
    statusCode: undefined as number | undefined,
    redirectedTo: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    redirect(url: string) {
      res.redirectedTo = url;
      return res;
    },
    send() {
      return res;
    },
  };
  return res;
}

describe.each([
  ['google', 'Gmail'],
  ['microsoft', 'Outlook'],
] as const)('connecting %s', (provider) => {
  let controller: GoogleOAuthController | MicrosoftOAuthController;
  let consentUrl: ReturnType<typeof vi.fn>;
  let complete: ReturnType<typeof vi.fn>;
  let startWatching: ReturnType<typeof vi.fn>;
  let logger: any;

  beforeEach(() => {
    consentUrl = vi.fn().mockReturnValue('https://provider.example/consent?state=SIGNED');
    complete = vi
      .fn()
      .mockResolvedValue({ accountId: 'account-1', emailAddress: 'me@example.com' });
    startWatching = vi.fn().mockResolvedValue(true);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const config = {
      env: { JWT_ACCESS_SECRET: SECRET, WEB_BASE_URL: 'https://app.example' },
    } as never;

    const linking = {
      consentUrl,
      microsoftConsentUrl: consentUrl,
      completeGoogleLink: complete,
      completeMicrosoftLink: complete,
      startWatching,
    } as never;

    controller =
      provider === 'google'
        ? new GoogleOAuthController(config, linking, logger)
        : new MicrosoftOAuthController(config, linking, logger);
  });

  const start = (req: unknown, returnTo?: string) =>
    (controller.start as (r: unknown, t?: string) => { url: string })(req, returnTo);

  const callback = (query: { code?: string; state?: string; error?: string }) => {
    const res = makeResponse();
    return (
      controller.callback as (
        res: unknown,
        code?: string,
        state?: string,
        error?: string,
      ) => Promise<void>
    )(res, query.code, query.state, query.error).then(() => res);
  };

  describe('starting', () => {
    it('returns the consent URL rather than redirecting', async () => {
      // A redirect endpoint cannot be authenticated, because the browser
      // following it sends no bearer token.
      const result = start({ user: { id: USER } });

      expect(result).toEqual({ url: 'https://provider.example/consent?state=SIGNED' });
    });

    it('signs the authenticated user into the state', () => {
      start({ user: { id: USER } });

      const state = verifyOAuthState(consentUrl.mock.calls[0]![0] as string, SECRET);
      expect(state.userId).toBe(USER);
      expect(state.provider).toBe(provider);
    });

    it('takes the user from the verified token and nowhere else', () => {
      // A `userId` in the query would let anyone attach a mailbox to someone
      // else's account. There is no parameter for it to arrive in.
      start({ user: { id: USER }, query: { userId: 'attacker' } });

      const state = verifyOAuthState(consentUrl.mock.calls[0]![0] as string, SECRET);
      expect(state.userId).toBe(USER);
    });

    it('carries a return path through', () => {
      start({ user: { id: USER } }, '/settings/accounts');

      const state = verifyOAuthState(consentUrl.mock.calls[0]![0] as string, SECRET);
      expect(state.returnTo).toBe('/settings/accounts');
    });
  });

  describe('the callback', () => {
    const signedState = () => {
      start({ user: { id: USER } });
      return consentUrl.mock.calls[0]![0] as string;
    };

    it('completes the link and sends the user back', async () => {
      const res = await callback({ code: 'auth-code', state: signedState() });

      expect(complete).toHaveBeenCalledWith(USER, 'auth-code');
      expect(res.redirectedTo).toContain('connect=success');
      expect(res.redirectedTo).toContain('me%40example.com');
    });

    it('refuses a forged state rather than trusting the code', async () => {
      // Without this, an attacker completes consent with *their* mailbox and
      // tricks a signed-in victim into loading the callback.
      await expect(callback({ code: 'auth-code', state: 'forged' })).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
    });

    it('refuses a missing state', async () => {
      await expect(callback({ code: 'auth-code' })).rejects.toThrow();
      expect(complete).not.toHaveBeenCalled();
    });

    it('refuses a state signed with a different secret', async () => {
      const otherController =
        provider === 'google'
          ? new GoogleOAuthController(
              { env: { JWT_ACCESS_SECRET: 'b'.repeat(48) } } as never,
              { consentUrl } as never,
              logger,
            )
          : new MicrosoftOAuthController(
              { env: { JWT_ACCESS_SECRET: 'b'.repeat(48) } } as never,
              { microsoftConsentUrl: consentUrl } as never,
              logger,
            );

      (otherController.start as (r: unknown) => unknown)({ user: { id: USER } });
      const foreign = consentUrl.mock.calls.at(-1)![0] as string;

      await expect(callback({ code: 'auth-code', state: foreign })).rejects.toThrow();
    });

    it('takes a declined consent back without an error page', async () => {
      // The user said no, or an admin policy refused. Not a failure on our side.
      const res = await callback({ error: 'access_denied' });

      expect(res.redirectedTo).toContain('connect=cancelled');
      expect(complete).not.toHaveBeenCalled();
    });

    it('refuses a callback with no code', async () => {
      await expect(callback({ state: signedState() })).rejects.toThrow();
    });

    it('says the mailbox is on polling when watching could not start', async () => {
      // A connected mailbox that is not yet watched still works. Failing the
      // whole connection over it would leave the user with nothing.
      startWatching.mockResolvedValue(false);

      const res = await callback({ code: 'auth-code', state: signedState() });

      expect(res.redirectedTo).toContain('mode=polling');
    });

    it('does not say so when it did', async () => {
      const res = await callback({ code: 'auth-code', state: signedState() });
      expect(res.redirectedTo).not.toContain('mode=polling');
    });
  });
});

describe('the guards are actually applied', () => {
  /**
   * Every test above calls the handler directly, which proves nothing about
   * whether a guard runs in front of it — and the bug this file exists for was
   * precisely a guard that was written, exported, and never attached.
   *
   * So the decorator metadata is read instead. Nest stores guards under
   * `__guards__` on the method, and it is `undefined` for an unguarded one.
   */
  const guardsOn = (target: object, method: string): string[] => {
    const handler = (target as Record<string, unknown>)[method] as object;
    const guards = (Reflect.getMetadata('__guards__', handler) ?? []) as Array<{ name?: string }>;
    return guards.map((g) => g.name ?? String(g));
  };

  it.each([
    ['Google', GoogleOAuthController],
    ['Microsoft', MicrosoftOAuthController],
  ])('%s start requires a token', (_label, controller) => {
    expect(guardsOn(controller.prototype, 'start')).toContain('AuthGuard');
  });

  it.each([
    ['Google', GoogleOAuthController],
    ['Microsoft', MicrosoftOAuthController],
  ])('%s callback does not, because a provider redirect carries none', (_label, controller) => {
    // Guarding it would make the flow unfinishable. Identity comes from the
    // signed state, which is what state is for.
    expect(guardsOn(controller.prototype, 'callback')).toEqual([]);
  });
});
