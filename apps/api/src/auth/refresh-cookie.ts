/**
 * Carrying the refresh token in a cookie the page cannot read.
 *
 * It was not carried anywhere. The API returned `refreshToken` in the sign-in
 * body and required it in the refresh body; the dashboard sent
 * `POST /v1/auth/refresh` with `credentials: 'include'` and **no body**, on the
 * belief — stated in a comment right there — that the token rode in an HttpOnly
 * cookie. Nothing set one. So every refresh answered 400, and the dashboard
 * signed the user out the moment their fifteen-minute access token expired.
 *
 * Two pieces of documentation asserted the cookie existed: that comment, and
 * invariant 15 in `docs/status.md`, which claimed the refresh token was "an
 * HttpOnly cookie script cannot read". Both were written against a design
 * nobody implemented, and neither side was ever run against the other — the API
 * tests post a body, and the dashboard tests stub `fetch`.
 *
 * `SESSION_COOKIE_NAME` was in `.env.example` from the first phase and read by
 * nothing, which is the same tell the other four gave.
 *
 * Parsed by hand rather than with `cookie-parser`: this needs one name out of
 * one header, the middleware would run on every request including the webhooks
 * that must not be slowed, and a dependency is a thing to keep patched.
 */

/** Only this endpoint prefix ever needs it, so the browser sends it nowhere else. */
export const REFRESH_COOKIE_PATH = '/v1/auth';

export interface RefreshCookieOptions {
  name: string;
  /** `Secure` is omitted outside production — a localhost dashboard is http. */
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * The `Set-Cookie` value.
 *
 * `SameSite=Strict` is what makes CSRF structural rather than a token: a
 * cross-site form post carries no cookie, so it cannot refresh, and every other
 * state-changing endpoint needs a bearer token that lives only in memory.
 *
 * `Path` scopes it to the auth endpoints, so the token is not attached to the
 * dozens of ordinary API calls that have no use for it — fewer places for it to
 * end up in a log or a proxy's request record.
 */
export function refreshCookie(value: string, options: RefreshCookieOptions): string {
  const parts = [
    `${options.name}=${encodeURIComponent(value)}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
  ];

  if (options.secure) parts.push('Secure');

  return parts.join('; ');
}

/** The same cookie, expired. Sent on sign-out so the browser drops it. */
export function clearedRefreshCookie(
  options: Pick<RefreshCookieOptions, 'name' | 'secure'>,
): string {
  const parts = [
    `${options.name}=`,
    `Path=${REFRESH_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];

  if (options.secure) parts.push('Secure');

  return parts.join('; ');
}

/**
 * Reads one cookie out of a `Cookie` header.
 *
 * Deliberately tolerant of the shapes browsers and proxies actually send —
 * `a=1;b=2`, extra spaces, a value containing `=` — and deliberately not a
 * general parser. It returns the first match; a duplicate name is a client
 * doing something strange and the first is what browsers themselves use.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;

  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;

    if (pair.slice(0, index).trim() !== name) continue;

    const raw = pair.slice(index + 1).trim();
    if (!raw) return undefined;

    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed escape. Treated as absent rather than passed through: a
      // half-decoded token cannot authenticate anything, and the caller's
      // "no token" path is already correct.
      return undefined;
    }
  }

  return undefined;
}
