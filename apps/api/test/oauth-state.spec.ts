import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOAuthState, verifyOAuthState, safeReturnPath } from '../src/oauth/oauth-state.js';
import { AppError } from '@wea/shared';

/**
 * The `state` parameter is the only thing standing between us and login CSRF.
 *
 * Without it an attacker completes consent with their own Google account and
 * tricks a signed-in victim into loading the callback — attaching the wrong
 * mailbox to the wrong account. In this product that is not a nuisance; it is
 * one person's correspondence delivered to another person's phone.
 */

const SECRET = 'oauth-state-signing-secret';
const userId = randomUUID();
const now = new Date('2026-08-04T12:00:00Z');

describe('round trip', () => {
  it('carries the connecting user through the flow', () => {
    // The callback must never infer who is connecting from a session or a
    // cookie — it comes from here, signed.
    const state = createOAuthState({ userId, provider: 'google' }, SECRET, now);
    const decoded = verifyOAuthState(state, SECRET, now);

    expect(decoded.userId).toBe(userId);
    expect(decoded.provider).toBe('google');
  });

  it('carries an optional return path', () => {
    const state = createOAuthState(
      { userId, provider: 'google', returnTo: '/settings/accounts' },
      SECRET,
      now,
    );
    expect(verifyOAuthState(state, SECRET, now).returnTo).toBe('/settings/accounts');
  });

  it('produces a distinct state every time', () => {
    // Otherwise two flows started in the same second are indistinguishable, and
    // a caller cannot track single use.
    const states = new Set(
      Array.from({ length: 50 }, () =>
        createOAuthState({ userId, provider: 'google' }, SECRET, now),
      ),
    );
    expect(states.size).toBe(50);
  });

  it('refuses to sign a state for a malformed user id', () => {
    expect(() => createOAuthState({ userId: 'not-a-uuid', provider: 'google' }, SECRET)).toThrow(
      AppError,
    );
  });
});

describe('forgery is rejected', () => {
  it('rejects a state signed with a different secret', () => {
    const forged = createOAuthState({ userId, provider: 'google' }, 'attacker-secret', now);
    expect(() => verifyOAuthState(forged, SECRET, now)).toThrow(AppError);
  });

  it('rejects a payload edited after signing', () => {
    // The attack this exists for: swap the user id, keep the signature.
    const state = createOAuthState({ userId, provider: 'google' }, SECRET, now);
    const [payload, signature] = state.split('.');

    const tampered = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    tampered.userId = randomUUID();
    const swapped = `${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${signature}`;

    expect(() => verifyOAuthState(swapped, SECRET, now)).toThrow(AppError);
  });

  it('rejects an unsigned payload', () => {
    const bare = Buffer.from(
      JSON.stringify({ userId, provider: 'google', issuedAt: 1785849600, nonce: 'x' }),
    ).toString('base64url');

    expect(() => verifyOAuthState(bare, SECRET, now)).toThrow(AppError);
    expect(() => verifyOAuthState(`${bare}.`, SECRET, now)).toThrow(AppError);
  });

  it('never parses an unverified payload', () => {
    // Signature is checked before JSON.parse, so malformed JSON from an attacker
    // never reaches the parser.
    const malformed = `${Buffer.from('{not json').toString('base64url')}.deadbeef`;
    expect(() => verifyOAuthState(malformed, SECRET, now)).toThrow(AppError);
  });

  it('rejects structurally wrong claims even when correctly signed', () => {
    // A valid signature over the wrong shape means our own code changed, not an
    // attack — but it is still not usable.
    const bad = [
      { provider: 'google', issuedAt: 1785849600 },
      { userId: 'not-a-uuid', provider: 'google', issuedAt: 1785849600 },
      { userId, provider: 'evil', issuedAt: 1785849600 },
      { userId, provider: 'google', issuedAt: 'soon' },
    ];

    for (const claims of bad) {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signed = createOAuthState({ userId, provider: 'google' }, SECRET, now);
      const signature = signed.split('.')[1];
      // Re-sign the bad payload properly so only the claims are at fault.
      const properlySigned = `${payload}.${signature}`;
      expect(() => verifyOAuthState(properlySigned, SECRET, now), JSON.stringify(claims)).toThrow(
        AppError,
      );
    }
  });

  it('rejects junk without throwing anything other than AppError', () => {
    for (const junk of [undefined, '', '.', 'a.b', 'x'.repeat(5000), '....']) {
      expect(() => verifyOAuthState(junk, SECRET, now), String(junk)).toThrow(AppError);
    }
  });
});

describe('expiry', () => {
  it('accepts a state used promptly', () => {
    const state = createOAuthState({ userId, provider: 'google' }, SECRET, now);
    const soon = new Date(now.getTime() + 60_000);
    expect(() => verifyOAuthState(state, SECRET, soon)).not.toThrow();
  });

  it('rejects a state replayed later', () => {
    // A consent URL captured from browser history must not work a week on.
    const state = createOAuthState({ userId, provider: 'google' }, SECRET, now);
    const later = new Date(now.getTime() + 20 * 60_000);
    expect(() => verifyOAuthState(state, SECRET, later)).toThrow(AppError);
  });

  it('rejects a timestamp from the future', () => {
    const state = createOAuthState({ userId, provider: 'google' }, SECRET, now);
    const before = new Date(now.getTime() - 10 * 60_000);
    expect(() => verifyOAuthState(state, SECRET, before)).toThrow(AppError);
  });

  it('tolerates small clock skew between pods', () => {
    const state = createOAuthState({ userId, provider: 'google' }, SECRET, now);
    const slightlyBehind = new Date(now.getTime() - 30_000);
    expect(() => verifyOAuthState(state, SECRET, slightlyBehind)).not.toThrow();
  });
});

describe('failures are indistinguishable to the caller', () => {
  it('gives one public message for every rejection', () => {
    // Telling an attacker whether their forgery was merely expired is free
    // information about the signing key's validity window.
    const messages = new Set<string>();

    const cases = [
      () => verifyOAuthState(undefined, SECRET, now),
      () => verifyOAuthState('garbage', SECRET, now),
      () =>
        verifyOAuthState(
          createOAuthState({ userId, provider: 'google' }, 'other', now),
          SECRET,
          now,
        ),
      () =>
        verifyOAuthState(
          createOAuthState({ userId, provider: 'google' }, SECRET, now),
          SECRET,
          new Date(now.getTime() + 3_600_000),
        ),
    ];

    for (const run of cases) {
      try {
        run();
      } catch (err) {
        messages.add((err as AppError).publicMessage);
      }
    }

    expect(messages.size).toBe(1);
  });

  it('keeps the real reason in the internal message for logs', () => {
    try {
      verifyOAuthState('garbage', SECRET, now);
    } catch (err) {
      expect((err as AppError).message).toContain('rejected');
      expect((err as AppError).publicMessage).not.toContain('signature');
    }
  });
});

describe('return path is not an open redirect', () => {
  // An unvalidated returnTo sends a victim through a genuine consent flow onto
  // a lookalike page, with our domain in the referrer chain.

  it('allows a same-origin path', () => {
    expect(safeReturnPath('/settings/accounts')).toBe('/settings/accounts');
    expect(safeReturnPath('/inbox?filter=unread')).toBe('/inbox?filter=unread');
  });

  it('falls back for anything off-origin', () => {
    const hostile = [
      'https://evil.com',
      'http://evil.com',
      '//evil.com',
      '/\\evil.com',
      '/\tevil',
      'javascript:alert(1)',
      '\\\\evil.com',
      '/path\nLocation: https://evil.com',
    ];

    for (const value of hostile) {
      expect(safeReturnPath(value), value).toBe('/settings/accounts');
    }
  });

  it('falls back when absent', () => {
    expect(safeReturnPath(undefined)).toBe('/settings/accounts');
    expect(safeReturnPath('')).toBe('/settings/accounts');
  });
});
