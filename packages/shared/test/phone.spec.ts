import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  isE164,
  toWhatsAppFormat,
  fromWhatsAppFormat,
} from '../src/utils/phone.js';

describe('phone normalization', () => {
  it('accepts numbers already in E.164', () => {
    expect(normalizePhone('+254712345678')).toBe('+254712345678');
    expect(normalizePhone('+1 (415) 555-0132')).toBe('+14155550132');
  });

  it('converts international prefixes to +', () => {
    expect(normalizePhone('00254712345678')).toBe('+254712345678');
    expect(normalizePhone('011254712345678')).toBe('+254712345678');
  });

  it('applies a default calling code to a national number', () => {
    expect(normalizePhone('0712345678', '254')).toBe('+254712345678');
    expect(normalizePhone('712345678', '254')).toBe('+254712345678');
  });

  it('never guesses a country for a bare national number', () => {
    // Silently assuming a country would route a user's mail to the wrong
    // WhatsApp account.
    expect(normalizePhone('0712345678')).toBeNull();
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'not a phone', '+0123456789', '+123', 'abc123def']) {
      expect(normalizePhone(bad), bad).toBeNull();
    }
  });

  it('round-trips through Meta wire format', () => {
    const e164 = '+254712345678';
    expect(toWhatsAppFormat(e164)).toBe('254712345678');
    expect(fromWhatsAppFormat(toWhatsAppFormat(e164))).toBe(e164);
  });

  it('validates E.164', () => {
    expect(isE164('+254712345678')).toBe(true);
    expect(isE164('254712345678')).toBe(false);
    expect(isE164('+0123456789')).toBe(false);
  });
});
