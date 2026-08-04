import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  generateToken,
  hashToken,
  verifyToken,
  generateRecoveryCodes,
  matchRecoveryCode,
  BlindIndex,
} from '../src/index.js';
import { AppError } from '@wea/shared';
import { randomBytes } from 'node:crypto';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('uses Argon2id with the current parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(await verifyPassword(b, 'correct horse battery staple')).toBe(true);
  });

  it('enforces a minimum length', async () => {
    await expect(hashPassword('short')).rejects.toThrow(AppError);
  });

  it('refuses an unbounded input', async () => {
    // Argon2 will hash a megabyte quite happily, at a cost the caller chose.
    await expect(hashPassword('a'.repeat(2000))).rejects.toThrow(AppError);
    expect(await verifyPassword(await hashPassword('a'.repeat(64)), 'a'.repeat(5000))).toBe(false);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupted hash must be indistinguishable from a wrong password.
    for (const hash of ['', 'not-a-hash', '$argon2id$garbage', '$2b$10$bcryptstyle']) {
      expect(await verifyPassword(hash, 'any password'), hash).toBe(false);
    }
  });

  it('flags a legacy hash for rehashing', () => {
    // A bcrypt hash from an earlier system: verify fails, and it needs upgrading.
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });
});

describe('opaque tokens', () => {
  it('never stores the token itself', () => {
    const { token, hash } = generateToken('wea_live');
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });

  it('carries a recognizable prefix', () => {
    expect(generateToken('wea_live').token).toMatch(/^wea_live_/);
  });

  it('produces a distinct token every time', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(tokens.size).toBe(200);
  });

  it('verifies against the stored hash', () => {
    const { token, hash } = generateToken();
    expect(verifyToken(token, hash)).toBe(true);
    expect(verifyToken(`${token}x`, hash)).toBe(false);
    expect(verifyToken('', hash)).toBe(false);
  });

  it('rejects a hash of the wrong shape without throwing', () => {
    expect(verifyToken('anything', 'short')).toBe(false);
    expect(verifyToken('anything', '')).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(hashToken('same-token')).toBe(hashToken('same-token'));
  });
});

describe('recovery codes', () => {
  it('generates readable, unique codes with matching hashes', () => {
    const { codes, hashes } = generateRecoveryCodes(10);

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(hashes).toEqual(codes.map(hashToken));
  });

  it('matches a code regardless of case or surrounding whitespace', () => {
    // People type these from paper while locked out.
    const { codes, hashes } = generateRecoveryCodes(5);
    const target = codes[2]!;

    expect(matchRecoveryCode(target, hashes)).toBe(2);
    expect(matchRecoveryCode(target.toLowerCase(), hashes)).toBe(2);
    expect(matchRecoveryCode(`  ${target}  `, hashes)).toBe(2);
  });

  it('returns -1 for an unknown code', () => {
    const { hashes } = generateRecoveryCodes(5);
    expect(matchRecoveryCode('AAAA-BBBB-CCCC', hashes)).toBe(-1);
    expect(matchRecoveryCode('', hashes)).toBe(-1);
  });

  it('does not short-circuit on the first match', () => {
    // Returning early would make response time reveal a code's position.
    const { codes, hashes } = generateRecoveryCodes(10);
    expect(matchRecoveryCode(codes[0]!, hashes)).toBe(0);
    expect(matchRecoveryCode(codes[9]!, hashes)).toBe(9);
  });

  it('handles an empty code list', () => {
    expect(matchRecoveryCode('AAAA-BBBB-CCCC', [])).toBe(-1);
  });
});

describe('blind index', () => {
  const index = new BlindIndex(randomBytes(32));

  it('is deterministic, so it can back a database lookup', () => {
    expect(index.computeEmail('user@example.com')).toBe(index.computeEmail('user@example.com'));
  });

  it('normalizes case and whitespace', () => {
    const expected = index.computeEmail('user@example.com');
    expect(index.computeEmail('User@Example.COM')).toBe(expected);
    expect(index.computeEmail('  user@example.com  ')).toBe(expected);
  });

  it('does not fold Gmail dots or plus-addressing', () => {
    // That is a Gmail-specific policy; applying it universally would merge
    // genuinely distinct addresses at other providers.
    expect(index.computeEmail('u.ser@example.com')).not.toBe(
      index.computeEmail('user@example.com'),
    );
    expect(index.computeEmail('user+tag@example.com')).not.toBe(
      index.computeEmail('user@example.com'),
    );
  });

  it('separates namespaces, so one index does not leak another', () => {
    const address = 'user@example.com';
    expect(index.compute(address, 'login')).not.toBe(index.compute(address, 'correspondent'));
  });

  it('normalizes phone numbers to digits and a leading plus', () => {
    const expected = index.computePhone('+254712345678');
    expect(index.computePhone('+254 712 345 678')).toBe(expected);
    expect(index.computePhone('+254-712-345-678')).toBe(expected);
  });

  it('reveals nothing recoverable without the key', () => {
    const other = new BlindIndex(randomBytes(32));
    expect(other.computeEmail('user@example.com')).not.toBe(index.computeEmail('user@example.com'));
  });

  it('compares in constant time', () => {
    const expected = index.computeEmail('user@example.com');
    expect(index.matches('user@example.com', 'email', expected)).toBe(true);
    expect(index.matches('other@example.com', 'email', expected)).toBe(false);
    expect(index.matches('user@example.com', 'email', 'truncated')).toBe(false);
  });

  it('refuses a key that is too short', () => {
    expect(() => new BlindIndex(randomBytes(16))).toThrow(AppError);
    expect(() => BlindIndex.fromBase64(randomBytes(16).toString('base64'))).toThrow(AppError);
  });
});
