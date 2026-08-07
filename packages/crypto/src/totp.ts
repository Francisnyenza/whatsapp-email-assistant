import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238).
 *
 * The second factor is the thing standing between a leaked password and someone
 * else's entire mailbox, so the details here are not cosmetic:
 *
 *  - **Comparison is constant-time.** A code is six digits — a million
 *    possibilities — and a comparison that returns early on the first wrong
 *    digit turns that into ten guesses per position for anyone who can measure
 *    the response. `timingSafeEqual` on equal-length buffers is the fix.
 *  - **Verification returns the step it matched.** The caller stores it and
 *    refuses anything at or below it next time, which is what stops a code
 *    shoulder-surfed or read off a screen from being replayed during the thirty
 *    seconds it remains valid. Without that, "one-time" is not true.
 *  - **The window is one step either side.** Phone clocks drift, and a user
 *    typing a code as it rolls over is the common case, not an attack. Wider
 *    than ±1 starts meaningfully enlarging the guessing surface.
 */

const DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;

/** How many steps either side of now are accepted. */
export const TOTP_WINDOW = 1;

/**
 * 160 bits, which is what RFC 4226 recommends for HMAC-SHA1 and what every
 * authenticator app expects. Shorter secrets are accepted by apps and quietly
 * weaken the whole factor.
 */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpVerification {
  /**
   * The time step the code matched. The caller must persist it and reject
   * anything at or below it on the next attempt — see the class comment.
   */
  step: number;
}

/** A fresh secret, base32-encoded as authenticator apps expect. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * The code for a given moment.
 *
 * Exported because a test that computes the expected code the same way the
 * verifier does proves nothing; the ability to generate one independently is
 * what makes the round trip meaningful.
 */
export function totpCode(secret: string, at: Date = new Date()): string {
  return codeForStep(secret, stepFor(at));
}

export function stepFor(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Checks a code.
 *
 * @param lastUsedStep the step of the last code this user successfully used, or
 *   null if none. Steps at or below it are refused even when the arithmetic
 *   matches — that is the replay guard, and it is the caller's job to persist
 *   what comes back.
 * @returns the matched step, or null. Null covers every failure — wrong code,
 *   malformed input, replay — because telling them apart tells an attacker
 *   which of their guesses was structurally right.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at?: Date; lastUsedStep?: number | null; window?: number } = {},
): TotpVerification | null {
  const normalized = code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;

  const current = stepFor(options.at ?? new Date());
  const window = options.window ?? TOTP_WINDOW;
  const lastUsed = options.lastUsedStep ?? null;

  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    // A code from a step already spent is not a valid code, however correct the
    // digits are.
    if (lastUsed !== null && step <= lastUsed) continue;

    if (constantTimeEquals(codeForStep(secret, step), normalized)) {
      return { step };
    }
  }

  return null;
}

/**
 * The URI an authenticator app scans.
 *
 * The label and issuer are percent-encoded because an email address legitimately
 * contains characters that would otherwise break the URI, and a broken URI is a
 * user who cannot enrol.
 */
export function otpauthUri(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });

  return `otpauth://totp/${label}?${params.toString()}`;
}

/* --------------------------------- internals -------------------------------- */

function codeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);

  // The counter is eight bytes, big-endian. BigInt rather than arithmetic
  // because a step is well within 2^53 today but the shift operations that
  // would otherwise build this are 32-bit.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on differing lengths, which would itself leak the
  // length. Both sides here are fixed-width six digits, and the regex above
  // guarantees it, so an unequal length is a caller bug rather than a probe.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  // Deliberately unpadded. Authenticator apps accept it, and the '=' padding is
  // a common source of copy-paste failures when a user types a secret by hand.
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    // A character outside the alphabet means the secret is corrupt. Skipping it
    // would silently derive a different key and produce codes that never match,
    // which is far harder to diagnose than a refusal.
    if (index === -1) throw new Error('Invalid base32 character in secret');

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}
