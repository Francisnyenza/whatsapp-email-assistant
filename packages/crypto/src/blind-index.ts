import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '@wea/shared';

/**
 * Blind indexes for encrypted, searchable columns.
 *
 * Encrypted values cannot be indexed or compared — but "find the account for
 * this email address" is a lookup we need on a hot path. A keyed HMAC of the
 * normalized value gives an equality-searchable column that reveals nothing
 * about the plaintext to anyone without the key.
 *
 * The tradeoffs, stated plainly:
 *
 *  * **Equality only.** No ordering, no prefix search, no LIKE. If a column
 *    needs range queries, a blind index is the wrong tool.
 *  * **Deterministic.** Identical inputs produce identical output, so an
 *    attacker holding the database can see that two rows share a value, and can
 *    confirm a guessed value if they also hold the key. It hides content, not
 *    equality.
 *  * **HMAC, not a bare hash.** Without the key, `sha256('user@gmail.com')` is
 *    trivially reversible from a wordlist of addresses.
 */

export class BlindIndex {
  constructor(private readonly key: Buffer) {
    if (key.length < 32) {
      throw new AppError('ENCRYPTION_FAILURE', 'Blind index key must be at least 32 bytes');
    }
  }

  static fromBase64(keyBase64: string): BlindIndex {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) {
      throw new AppError(
        'ENCRYPTION_FAILURE',
        'BLIND_INDEX_KEY must decode to 32 bytes (openssl rand -base64 32)',
      );
    }
    return new BlindIndex(key);
  }

  /**
   * Computes the index value for `plaintext`.
   *
   * `domain` separates namespaces so the same address indexed as a login email
   * and as a correspondent produces different values — otherwise one leaks the
   * other.
   */
  compute(plaintext: string, domain: string): string {
    return createHmac('sha256', this.key)
      .update(domain)
      .update('\0')
      .update(plaintext)
      .digest('hex');
  }

  /**
   * Index for an email address, lower-cased and trimmed.
   *
   * Normalization has to be exact and stable: `User@Example.com` and
   * `user@example.com` are the same mailbox, and if they index differently the
   * lookup silently misses. Gmail's dot- and plus-folding is deliberately *not*
   * applied — that is a Gmail-specific policy, and applying it universally would
   * merge genuinely distinct addresses at other providers.
   */
  computeEmail(address: string, domain = 'email'): string {
    return this.compute(address.trim().toLowerCase(), domain);
  }

  /** Index for an E.164 phone number, digits and leading '+' only. */
  computePhone(phone: string, domain = 'phone'): string {
    const normalized = phone.trim().replace(/[^\d+]/g, '');
    return this.compute(normalized, domain);
  }

  /** Constant-time comparison, for when an index value arrives from a request. */
  matches(plaintext: string, domain: string, expected: string): boolean {
    const actual = this.compute(plaintext, domain);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
  }
}
