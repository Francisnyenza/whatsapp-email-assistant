import { describe, it, expect } from 'vitest';
import {
  refreshCookie,
  clearedRefreshCookie,
  readCookie,
  REFRESH_COOKIE_PATH,
} from '../src/auth/refresh-cookie.js';

/**
 * The cookie three files claimed existed and nothing set.
 *
 * `auth.controller.ts` said refresh tokens were returned in the body rather
 * than as cookies. `apps/web/src/lib/api.ts` said the opposite — "the refresh
 * token rides in an HttpOnly cookie" — and sent `POST /v1/auth/refresh` with
 * `credentials: 'include'` and no body. Invariant 15 in `docs/status.md` agreed
 * with the dashboard. The API agreed with its own comment and required the
 * token in the body.
 *
 * So every refresh the dashboard made answered 400, and a signed-in user was
 * signed out fifteen minutes later, every time. Neither side was ever run
 * against the other: the API tests post a body, and the dashboard tests stub
 * `fetch`. Two suites, both green, describing different products.
 *
 * `SESSION_COOKIE_NAME` had been in `.env.example` since the first phase and
 * was read by nothing, which is the tell four other settings gave first.
 */

const options = { name: 'wea_session', secure: true, maxAgeSeconds: 2_592_000 };

describe('the cookie that is set', () => {
  it('is HttpOnly, so an XSS cannot lift a session that outlives the tab', () => {
    // The property invariant 15 is about. Without it, script on the page can
    // read the token that mints new access tokens for thirty days.
    expect(refreshCookie('rt_abc', options)).toContain('HttpOnly');
  });

  it('is SameSite=Strict, which is what makes CSRF structural', () => {
    // A cross-site form post carries no cookie, so it cannot refresh — and
    // every other state-changing endpoint needs a bearer token held only in
    // memory. That is the whole CSRF story; there is no token to forget.
    expect(refreshCookie('rt_abc', options)).toContain('SameSite=Strict');
  });

  it('is scoped to the auth endpoints', () => {
    // So the token is not attached to the dozens of ordinary calls with no use
    // for it — fewer places for it to land in a log or a proxy's records.
    expect(refreshCookie('rt_abc', options)).toContain(`Path=${REFRESH_COOKIE_PATH}`);
  });

  it('outlives the access token by a long way, matching the session row', () => {
    expect(refreshCookie('rt_abc', options)).toContain('Max-Age=2592000');
  });

  it('is Secure in production', () => {
    expect(refreshCookie('rt_abc', options)).toContain('Secure');
  });

  it('is not Secure elsewhere, or the first local run cannot sign in', () => {
    // The dashboard is served over http on localhost. A Secure cookie there is
    // set by nothing and sent by nothing, which reads exactly like the bug this
    // file exists for.
    expect(refreshCookie('rt_abc', { ...options, secure: false })).not.toContain('Secure');
  });

  it('escapes the value', () => {
    expect(refreshCookie('a b;c', options)).toContain('wea_session=a%20b%3Bc');
  });
});

describe('clearing it', () => {
  it('expires immediately and keeps the same path', () => {
    // A cookie cleared on a different Path is not cleared at all — the browser
    // keeps the original, and the next page load signs the user back in.
    const cleared = clearedRefreshCookie({ name: 'wea_session', secure: true });

    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain(`Path=${REFRESH_COOKIE_PATH}`);
    expect(cleared).toContain('wea_session=;');
  });
});

describe('reading one back', () => {
  it('finds it among others', () => {
    expect(readCookie('theme=dark; wea_session=rt_abc; other=1', 'wea_session')).toBe('rt_abc');
  });

  it('tolerates the spacing browsers and proxies actually send', () => {
    expect(readCookie('a=1;wea_session=rt_abc', 'wea_session')).toBe('rt_abc');
    expect(readCookie('  wea_session = rt_abc  ', 'wea_session')).toBe('rt_abc');
  });

  it('does not match a name that merely ends with it', () => {
    // `not_wea_session` must not answer for `wea_session`, or an attacker who
    // can set any cookie on the domain can choose the token.
    expect(readCookie('not_wea_session=evil', 'wea_session')).toBeUndefined();
  });

  it('round-trips a value that needed escaping', () => {
    const header = refreshCookie('a b;c', options).split(';')[0]!;
    expect(readCookie(header, 'wea_session')).toBe('a b;c');
  });

  it('treats an empty or malformed value as absent', () => {
    // A half-decoded token authenticates nothing, and the caller's "no token"
    // path is already the right one.
    expect(readCookie('wea_session=', 'wea_session')).toBeUndefined();
    expect(readCookie('wea_session=%E0%A4%A', 'wea_session')).toBeUndefined();
  });

  it('copes with no header at all', () => {
    expect(readCookie(undefined, 'wea_session')).toBeUndefined();
    expect(readCookie('', 'wea_session')).toBeUndefined();
  });
});
