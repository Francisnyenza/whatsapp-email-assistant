/**
 * Phone number normalization.
 *
 * A user's WhatsApp number is their identity on the messaging side, so it must
 * normalize to exactly one canonical form. Meta sends E.164 without the leading
 * `+`; users type it every other way. We store E.164 *with* the `+` and convert
 * at the API boundary.
 */

/** Loose E.164: leading '+', country digit 1-9, then up to 14 more digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Normalizes user input to E.164.
 *
 * @param input       what the user typed
 * @param defaultCallingCode  digits only, e.g. '254' — used when the input is a
 *   national number with a leading trunk '0'
 * @returns E.164 with '+', or null when the input cannot be made valid. Never
 *   guesses a country: a bare national number without a default code is a
 *   failure, not an assumption.
 */
export function normalizePhone(input: string, defaultCallingCode?: string): string | null {
  if (!input) return null;

  let s = input.trim().replace(/[\s().-]/g, '');

  // International prefixes: 00 (most of the world), 011 (NANP).
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  else if (s.startsWith('011') && !defaultCallingCode) s = `+${s.slice(3)}`;

  if (s.startsWith('+')) {
    return E164.test(s) ? s : null;
  }

  if (!/^\d+$/.test(s)) return null;

  if (defaultCallingCode) {
    const cc = defaultCallingCode.replace(/\D/g, '');
    // Strip a national trunk prefix before prepending the country code:
    // 0712345678 with cc 254 → +254712345678.
    const national = s.startsWith('0') ? s.slice(1) : s;
    const candidate = `+${cc}${national}`;
    return E164.test(candidate) ? candidate : null;
  }

  // No '+' and no default: only accept it if it is already a full international
  // number that merely lost its plus.
  const candidate = `+${s}`;
  return E164.test(candidate) ? candidate : null;
}

/** Meta's wire format: E.164 without the '+'. */
export function toWhatsAppFormat(e164: string): string {
  return e164.startsWith('+') ? e164.slice(1) : e164;
}

/** Converts Meta's wire format back to stored E.164. */
export function fromWhatsAppFormat(waNumber: string): string {
  return waNumber.startsWith('+') ? waNumber : `+${waNumber}`;
}
