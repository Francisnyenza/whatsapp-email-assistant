import argon2 from 'argon2';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { AppError } from '@wea/shared';

/**
 * Password and token hashing.
 *
 * Argon2id for passwords: memory-hard, so a GPU farm buys far less than it does
 * against bcrypt, and the OWASP-recommended default for new systems.
 *
 * SHA-256 for tokens. That is deliberate and not an inconsistency: refresh
 * tokens, API keys and invite tokens are 256 bits of our own randomness, not
 * user-chosen secrets. They are not guessable, so there is nothing for a slow
 * KDF to defend against — and they are verified on every authenticated request,
 * where an Argon2 hash per call would be a self-inflicted denial of service.
 */

/**
 * OWASP's 2024 baseline. `memoryCost` dominates: 19 MiB per hash means a login
 * flood is also a memory flood, which is why login is rate-limited separately.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/** Long enough that Argon2 is the only defence needed; the rest is user choice. */
const MIN_PASSWORD_LENGTH = 12;
/** Argon2 hashes inputs of any size, but accepting megabytes is a DoS vector. */
const MAX_PASSWORD_LENGTH = 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AppError('VALIDATION_FAILED', 'Password too short', {
      publicMessage: `Passwords must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AppError('VALIDATION_FAILED', 'Password too long', {
      publicMessage: `Passwords must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    });
  }
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a password. Returns false for any failure — a malformed stored hash
 * must not be distinguishable from a wrong password.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash || !password || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * True when a stored hash was produced with weaker parameters than we now use.
 * Call after a successful verify and re-hash in place — the only moment the
 * plaintext is available.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/* ------------------------------- opaque tokens ------------------------------ */

export interface GeneratedToken {
  /** Shown to the user exactly once. */
  token: string;
  /** What gets stored. */
  hash: string;
}

/**
 * Mints a 256-bit random token and its storage hash.
 *
 * `prefix` makes a leaked token identifiable in logs and scannable by secret
 * detection — `wea_live_…` is recognizably ours.
 */
export function generateToken(prefix?: string): GeneratedToken {
  const raw = randomBytes(32).toString('base64url');
  const token = prefix ? `${prefix}_${raw}` : raw;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time token comparison. */
export function verifyToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Recovery codes for two-factor authentication.
 *
 * Grouped into readable blocks because people type these by hand, from paper,
 * while locked out and stressed.
 */
export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(6).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return { codes, hashes: codes.map(hashToken) };
}

/**
 * Finds which stored recovery-code hash matches, without leaking through timing
 * which position it was in. Returns the index, or -1.
 *
 * Every hash is compared even after a match is found — returning early would
 * make the response time a function of the code's position.
 */
export function matchRecoveryCode(code: string, hashes: string[]): number {
  const normalized = code.trim().toUpperCase();
  let found = -1;
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i];
    if (hash && verifyToken(normalized, hash) && found === -1) found = i;
  }
  return found;
}
