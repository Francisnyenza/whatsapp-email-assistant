import { describe, it, expect } from 'vitest';
import {
  generateTotpSecret,
  totpCode,
  stepFor,
  verifyTotp,
  otpauthUri,
  base32Encode,
  base32Decode,
  TOTP_STEP_SECONDS,
} from '../src/index.js';

/**
 * Time-based one-time passwords.
 *
 * This is the thing standing between a leaked password and someone else's
 * entire mailbox, so the first thing checked is that it is actually RFC 6238
 * and not something that merely looks like it. An implementation that is
 * self-consistent but wrong passes every round-trip test and then rejects every
 * code a real authenticator app produces.
 */

describe('RFC 6238 reference vectors', () => {
  // The published seed is the ASCII string "12345678901234567890", which the
  // RFC expresses in hex. Base32 is what an authenticator app takes.
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ];

  for (const [unixSeconds, expected] of vectors) {
    it(`matches the published code at t=${unixSeconds}`, () => {
      expect(totpCode(secret, new Date(unixSeconds * 1000))).toBe(expected);
    });
  }
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0x42]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it('matches the RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('tolerates padding, spaces and lower case, because users type these', () => {
    expect(base32Decode('mzxw 6ytb oi==')).toEqual(Buffer.from('foobar'));
  });

  it('refuses a corrupt secret rather than deriving a different key', () => {
    // Skipping the bad character would produce codes that never match, which is
    // far harder to diagnose than a refusal.
    expect(() => base32Decode('MZXW6YT!OI')).toThrow();
  });
});

describe('verification', () => {
  const secret = generateTotpSecret();
  const now = new Date('2026-08-06T12:00:00Z');

  it('accepts the current code', () => {
    expect(verifyTotp(secret, totpCode(secret, now), { at: now })).not.toBeNull();
  });

  it('rejects a code for a different secret', () => {
    expect(verifyTotp(secret, totpCode(generateTotpSecret(), now), { at: now })).toBeNull();
  });

  it('accepts a code one step old, because phone clocks drift', () => {
    const previous = totpCode(secret, new Date(now.getTime() - TOTP_STEP_SECONDS * 1000));
    expect(verifyTotp(secret, previous, { at: now })).not.toBeNull();
  });

  it('accepts a code one step early, because a user typing as it rolls over is normal', () => {
    const next = totpCode(secret, new Date(now.getTime() + TOTP_STEP_SECONDS * 1000));
    expect(verifyTotp(secret, next, { at: now })).not.toBeNull();
  });

  it('rejects a code two steps old', () => {
    // Wider than ±1 meaningfully enlarges the guessing surface.
    const old = totpCode(secret, new Date(now.getTime() - 2 * TOTP_STEP_SECONDS * 1000));
    expect(verifyTotp(secret, old, { at: now })).toBeNull();
  });

  it('tolerates spaces and dashes in what the user typed', () => {
    const code = totpCode(secret, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(secret, spaced, { at: now })).not.toBeNull();
  });

  describe('returns null rather than throwing', () => {
    for (const [label, code] of [
      ['an empty string', ''],
      ['letters', 'abcdef'],
      ['too few digits', '12345'],
      ['too many digits', '1234567'],
      ['a negative number', '-12345'],
    ] as const) {
      it(`for ${label}`, () => {
        expect(verifyTotp(secret, code, { at: now })).toBeNull();
      });
    }
  });
});

describe('replay', () => {
  const secret = generateTotpSecret();
  const now = new Date('2026-08-06T12:00:00Z');

  it('reports which step matched, so the caller can spend it', () => {
    const result = verifyTotp(secret, totpCode(secret, now), { at: now });
    expect(result!.step).toBe(stepFor(now));
  });

  it('refuses a code already used', () => {
    // Without this, "one-time" is not true: a code read off a screen stays valid
    // for the rest of its thirty seconds.
    const code = totpCode(secret, now);
    const first = verifyTotp(secret, code, { at: now })!;

    expect(verifyTotp(secret, code, { at: now, lastUsedStep: first.step })).toBeNull();
  });

  it('refuses an older code once a newer one has been used', () => {
    const previous = totpCode(secret, new Date(now.getTime() - TOTP_STEP_SECONDS * 1000));
    const current = verifyTotp(secret, totpCode(secret, now), { at: now })!;

    expect(verifyTotp(secret, previous, { at: now, lastUsedStep: current.step })).toBeNull();
  });

  it('still accepts the next code', () => {
    const spent = verifyTotp(secret, totpCode(secret, now), { at: now })!;
    const later = new Date(now.getTime() + TOTP_STEP_SECONDS * 1000);

    expect(
      verifyTotp(secret, totpCode(secret, later), { at: later, lastUsedStep: spent.step }),
    ).not.toBeNull();
  });
});

describe('secrets', () => {
  it('are 160 bits, which is what apps expect', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  it('are different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(seen.size).toBe(50);
  });

  it('contain only characters an app can read', () => {
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('the enrolment URI', () => {
  const uri = otpauthUri({
    secret: 'JBSWY3DPEHPK3PXP',
    account: 'sarah+work@acme.com',
    issuer: 'WhatsApp Email Assistant',
  });

  it('is an otpauth totp URI', () => {
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
  });

  it('percent-encodes an address that would otherwise break it', () => {
    // A '+' in an email address is legitimate and would be read as a space.
    expect(uri).toContain('sarah%2Bwork%40acme.com');
  });

  it('states the parameters rather than relying on app defaults', () => {
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(params.get('algorithm')).toBe('SHA1');
  });
});
