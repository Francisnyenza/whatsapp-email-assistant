import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification.
 *
 * Every webhook endpoint is a public, unauthenticated URL that causes us to read
 * mailboxes and send messages. Signature verification is the only thing standing
 * between that and anyone who learns the URL.
 *
 * Three rules, each of which has been a real CVE in someone else's code:
 *
 *  1. **Compare in constant time.** `===` on an HMAC leaks the signature one
 *     byte at a time.
 *  2. **Verify against the raw body.** `JSON.parse` then re-serialize changes
 *     bytes — key order, unicode escapes, whitespace — and the signature no
 *     longer matches. The framework must hand over the untouched buffer.
 *  3. **Never fall open.** A missing or malformed signature header is a
 *     rejection, not a skip.
 */

/** Timing-safe comparison of two strings of any length. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Length is not secret, and timingSafeEqual requires equal lengths.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verifies Meta's `X-Hub-Signature-256` header over a WhatsApp webhook body.
 *
 * The header is `sha256=<hex>` of HMAC-SHA256(rawBody, appSecret).
 *
 * @param rawBody the exact bytes received — not a re-serialized object
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;

  const [algorithm, provided] = signatureHeader.split('=', 2);
  if (algorithm !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeCompare(provided, expected);
}

/**
 * Verifies Stripe's `Stripe-Signature` header.
 *
 * Format: `t=<unix>,v1=<hex>[,v1=<hex>…]`, signed over `"<t>.<rawBody>"`.
 * The timestamp check is what stops a captured-and-replayed webhook, so it is
 * not optional.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds = 300,
): boolean {
  if (!signatureHeader || !webhookSecret) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.split('=', 2);
    if (!value) continue;
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');

  // Stripe may send several during a secret rotation; any valid one passes.
  return signatures.some((sig) => safeCompare(sig, expected));
}

/**
 * Verifies Microsoft Graph's `clientState`.
 *
 * Graph does not sign change notifications. It echoes back an opaque string we
 * chose when creating the subscription, which is the whole of the authentication
 * — so it must be high-entropy, compared in constant time, and treated as a
 * shared secret rather than an identifier.
 */
export function verifyGraphClientState(received: string | undefined, expected: string): boolean {
  if (!received || !expected) return false;
  return safeCompare(received, expected);
}

/**
 * Signs an internal payload — used for OAuth `state` and one-time links, where
 * we need to hand a value to a third party and trust it when it returns.
 */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function verifyPayloadSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  return safeCompare(signature, signPayload(payload, secret));
}
