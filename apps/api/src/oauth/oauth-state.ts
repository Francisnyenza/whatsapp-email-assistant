import { randomBytes } from 'node:crypto';
import { AppError } from '@wea/shared';
import { signPayload, safeCompare } from '@wea/crypto';

/**
 * The OAuth `state` parameter.
 *
 * `state` is the only thing standing between us and login CSRF: without it, an
 * attacker completes a consent flow with *their* Google account and tricks a
 * signed-in victim into loading the callback, silently attaching the attacker's
 * mailbox to the victim's account — or, worse in this product, the reverse.
 *
 * So state is not a random opaque blob we look up. It is signed and carries its
 * own claims, which means:
 *
 *  * the callback can verify it without a server-side session, so it survives a
 *    load balancer moving the user between pods mid-flow;
 *  * it cannot be forged, because the HMAC covers every claim;
 *  * it expires, so a consent URL captured from a browser history cannot be
 *    replayed a week later.
 *
 * The nonce makes each state unique even for the same user and provider within
 * the same second, so a replay of a *previously used* state is detectable by the
 * caller if it chooses to track them.
 */

export interface OAuthState {
  /** Who is connecting. The whole point — the callback must not infer this. */
  userId: string;
  provider: 'google' | 'microsoft';
  /** Where to send the user afterwards. Validated against an allowlist. */
  returnTo?: string;
  /** Unix seconds. */
  issuedAt: number;
  nonce: string;
}

/** Consent flows are abandoned constantly; ten minutes is generous. */
const MAX_AGE_SECONDS = 600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createOAuthState(
  input: { userId: string; provider: OAuthState['provider']; returnTo?: string },
  secret: string,
  now: Date = new Date(),
): string {
  if (!UUID.test(input.userId)) {
    throw new AppError('BAD_REQUEST', 'OAuth state requires a valid user id');
  }

  const state: OAuthState = {
    userId: input.userId,
    provider: input.provider,
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    issuedAt: Math.floor(now.getTime() / 1000),
    nonce: randomBytes(9).toString('base64url'),
  };

  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${payload}.${signPayload(payload, secret)}`;
}

/**
 * Verifies and decodes a state parameter.
 *
 * Order matters: the signature is checked **before** the payload is parsed, so
 * malformed JSON from an attacker never reaches `JSON.parse`, and before the
 * expiry check, so an expired-but-unsigned value is rejected as forged rather
 * than as expired.
 *
 * @throws {AppError} for anything that is not a valid, current, well-formed
 *   state. Every failure raises the same public message — telling an attacker
 *   whether their forgery was merely expired is free information.
 */
export function verifyOAuthState(
  raw: string | undefined,
  secret: string,
  now: Date = new Date(),
): OAuthState {
  const reject = (reason: string): never => {
    throw new AppError('FORBIDDEN', `OAuth state rejected: ${reason}`, {
      publicMessage: 'That connection link is no longer valid. Please try connecting again.',
      retryable: false,
    });
  };

  if (!raw || typeof raw !== 'string') reject('missing');

  const separator = raw!.lastIndexOf('.');
  if (separator <= 0) reject('malformed');

  const payload = raw!.slice(0, separator);
  const signature = raw!.slice(separator + 1);

  // Signature first. Nothing below this line trusts the payload.
  if (!safeCompare(signature, signPayload(payload, secret))) reject('bad signature');

  let state: OAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  } catch {
    return reject('unparseable');
  }

  // A valid signature over a structurally wrong payload means our own signing
  // code changed shape, not an attack — but it is still not usable.
  if (
    typeof state?.userId !== 'string' ||
    !UUID.test(state.userId) ||
    (state.provider !== 'google' && state.provider !== 'microsoft') ||
    typeof state.issuedAt !== 'number' ||
    !Number.isFinite(state.issuedAt)
  ) {
    reject('invalid claims');
  }

  const ageSeconds = Math.floor(now.getTime() / 1000) - state.issuedAt;
  // Negative age means a clock skew or a forged future timestamp; neither is
  // something to accept.
  if (ageSeconds < -60 || ageSeconds > MAX_AGE_SECONDS) reject('expired');

  return state;
}

/**
 * Validates where to send the user after the flow.
 *
 * An unvalidated `returnTo` is an open redirect: an attacker sends a victim
 * through a genuine consent flow that lands them on a lookalike page, with our
 * domain in the referrer chain making it look legitimate.
 *
 * Only same-origin paths are permitted — not even our own domain spelled out,
 * because that invites subdomain confusion.
 */
export function safeReturnPath(
  returnTo: string | undefined,
  fallback = '/settings/accounts',
): string {
  if (!returnTo) return fallback;

  // Must be a bare path. Rejects absolute URLs, protocol-relative `//evil.com`,
  // and anything with a scheme.
  if (!returnTo.startsWith('/') || returnTo.startsWith('//')) return fallback;
  if (returnTo.includes('\\')) return fallback;
  // `/\evil.com` is treated as protocol-relative by some browsers.
  if (/^\/[\\/]/.test(returnTo)) return fallback;
  // Reject the whole control-character class rather than enumerating CR and LF.
  // A tab or a NUL in a Location header is handled inconsistently across
  // browsers and proxies, and there is no legitimate path containing one.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(returnTo)) return fallback;

  return returnTo;
}
