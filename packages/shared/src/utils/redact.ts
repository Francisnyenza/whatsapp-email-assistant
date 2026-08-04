import { createHash } from 'node:crypto';

/**
 * Log redaction.
 *
 * We operate on people's private correspondence. A stack trace that quotes an
 * email body, or a debug line carrying an OAuth refresh token, is a breach
 * waiting for a log aggregator to index it. Everything that reaches the logger
 * passes through here first.
 */

/** Keys whose values are never logged, matched case-insensitively as substrings. */
const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'auth',
  'apikey',
  'api_key',
  'accesskey',
  'refreshtoken',
  'privatekey',
  'credential',
  'cookie',
  'session',
  'totp',
  'otp',
  'recoverycode',
  'signature',
  'dek',
  'kek',
  'ciphertext',
];

/** Keys holding correspondence content — hashed to a fingerprint, never shown. */
const CONTENT_KEY_PATTERNS = [
  'bodytext',
  'bodyhtml',
  'body',
  'snippet',
  'subject',
  'summary',
  'text',
  'caption',
  'transcript',
];

const REDACTED = '[REDACTED]';

function matches(key: string, patterns: string[]): boolean {
  const k = key.toLowerCase();
  return patterns.some((p) => k.includes(p));
}

/** Short, stable, non-reversible fingerprint — lets us correlate without exposing. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * Masks an email address while keeping it recognizable in a log:
 * `sarah.chen@example.com` → `s***n@example.com`.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return REDACTED;
  const local = address.slice(0, at);
  const domain = address.slice(at);
  if (local.length <= 2) return `${local[0] ?? ''}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

/** Masks a phone number to its last four digits: `+254712345678` → `+2547****5678`. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return REDACTED;
  const prefix = phone.startsWith('+') ? '+' : '';
  return `${prefix}${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/** Masks addresses and phone numbers appearing inline in free text. */
export function redactString(input: string): string {
  return input.replace(EMAIL_RE, (m) => maskEmail(m)).replace(PHONE_RE, (m) => maskPhone(m));
}

/**
 * Deep-redacts an object for logging.
 *
 * - secret-looking keys → `[REDACTED]`
 * - content-looking keys → `[content:<hash> len=<n>]`
 * - free strings → inline addresses and numbers masked
 *
 * Cycles are handled; depth is capped so a pathological object cannot stall the
 * logger.
 */
export function redact<T>(value: T, maxDepth = 8): unknown {
  return redactInner(value, maxDepth, new WeakSet());
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (depth <= 0) return '[MAX_DEPTH]';

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack };
  }
  if (Buffer.isBuffer(value)) return `[buffer len=${value.length}]`;

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[CIRCULAR]';
    seen.add(value as object);

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v) => redactInner(v, depth - 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (matches(key, SECRET_KEY_PATTERNS)) {
        out[key] = REDACTED;
      } else if (matches(key, CONTENT_KEY_PATTERNS) && typeof val === 'string') {
        out[key] = `[content:${fingerprint(val)} len=${val.length}]`;
      } else if (key.toLowerCase().includes('email') && typeof val === 'string') {
        out[key] = maskEmail(val);
      } else if (key.toLowerCase().includes('phone') && typeof val === 'string') {
        out[key] = maskPhone(val);
      } else {
        out[key] = redactInner(val, depth - 1, seen);
      }
    }
    return out;
  }

  return '[UNSERIALIZABLE]';
}
