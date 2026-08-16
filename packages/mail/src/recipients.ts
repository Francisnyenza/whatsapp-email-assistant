import { AppError, type EmailAddress } from '@wea/shared';

/**
 * Turning text a user typed into an address we are willing to send to.
 *
 * Deliberately not `parseAddressList` from the Gmail normaliser. That one reads
 * headers off a message that already exists and is permissive on purpose — a
 * malformed `From:` on mail that arrived is a fact to record, not an error to
 * raise, and dropping the message would be worse than showing an odd name.
 * This one decides where a message *goes*, which is the opposite problem: the
 * only safe failure is refusing, because a wrong recipient means the user's
 * words arriving at a stranger and there is no recall.
 *
 * So this rejects rather than repairs. Anything it cannot read confidently
 * becomes an error the user sees and can correct, and nothing is guessed.
 *
 * The header-injection case is the one that matters beyond typos. A recipient
 * is interpolated into a `To:` header, and a newline inside it ends that header
 * and begins another — so `alice@x.com\nBcc: attacker@evil.com` is a silent
 * copy of every message to an address the user never saw.
 *
 * Worth knowing which guard catches what, because it decides what may be
 * removed. Disabling the control-character check fails only two of the six
 * injection cases: `ADDRESS` already rejects a newline in a *bare* address,
 * since the payload stops it matching. What the control check alone catches is the
 * **display-name** form — `Alice\r\nBcc: x@evil.com <alice@acme.com>` — where
 * the address part is perfectly valid and only the name carries the payload.
 * That is the case to keep in mind before simplifying this: `ADDRESS` is not a
 * substitute for it. `composeMime` guards the same thing again on the way out.
 */

/**
 * A single address, no display name.
 *
 * Stricter than RFC 5322 permits, and knowingly. The grammar allows quoted
 * local parts with spaces and comments in parentheses; accepting those here
 * would mean accepting text that is hard to show a user for confirmation and
 * hard to reason about when it is interpolated into a header. Addresses that
 * real people type are covered, and the ones that are not get a clear refusal
 * rather than a surprising send.
 */
const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/** `Display Name <addr@example.com>`, which is what people paste out of a mail client. */
const NAMED = /^(.{1,80}?)\s*<([^<>]+)>$/s;

/**
 * Long enough for a real address, short enough that nothing pathological gets
 * as far as the regex. The longest deliverable address is 254 octets.
 */
const MAX_ADDRESS_CHARS = 254;

/**
 * Whether text contains anything that could end a header or smuggle a new one.
 *
 * A code-point check rather than a regex, and not to dodge `no-control-regex`.
 * That rule exists because a control character inside a pattern is nearly always
 * a paste accident, and suppressing it here would leave a comment claiming this
 * one is deliberate — whereas naming the code points makes it unarguable. It
 * also reads as what it is: a list of things that must not appear.
 *
 * The whole C0 range and DEL rather than just CR and LF. A bare CR is enough on
 * some parsers, NUL truncates in others, and the Unicode line separators are
 * treated as line breaks by enough software to be worth refusing too. This is a
 * place to be broader than the known attack.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * One recipient.
 *
 * @throws {AppError} `VALIDATION_FAILED` with a `publicMessage` the user can
 *   act on. Every rejection names the address back, because "that is not a
 *   valid email" without saying which one is unhelpful when they typed three.
 */
export function parseRecipient(input: string): EmailAddress {
  const raw = input.trim();

  if (!raw) {
    throw refuse('No address given', 'Who should I send it to?');
  }

  // Before anything else, and before the length check, because a control
  // character in a 10 000-character string is still an injection attempt and
  // "too long" would be the wrong thing to tell anyone about it.
  if (hasControlCharacter(raw)) {
    throw refuse('Address contains a control character', 'That address has something odd in it.');
  }

  const named = NAMED.exec(raw);
  const addressPart = (named ? named[2]! : raw).trim();
  const namePart = named ? named[1]!.trim().replace(/^"|"$/g, '') : '';

  if (addressPart.length > MAX_ADDRESS_CHARS) {
    throw refuse('Address is too long', 'That address is too long to be real.');
  }

  if (!ADDRESS.test(addressPart)) {
    throw refuse(
      `Not a valid address: ${addressPart}`,
      `“${clamp(addressPart)}” is not an email address I can send to.`,
    );
  }

  return {
    // The domain is case-insensitive by definition, so lowercasing it is safe
    // and makes two spellings of one address compare equal. The local part is
    // *not* — RFC 5321 says the receiving server owns its meaning — so it is
    // preserved. Almost every provider treats it insensitively anyway; the
    // point is that preserving cannot break delivery and lowercasing, in
    // principle, can.
    address: lowercaseDomain(addressPart),
    ...(namePart ? { name: namePart } : {}),
  };
}

/**
 * Several recipients, from one comma- or semicolon-separated string.
 *
 * Bounded, because a compose flow is not a mailing list. Someone who pastes
 * forty addresses into a chat has either made a mistake or is doing something
 * this product should not make easy, and both are better answered with a limit
 * than with forty deliveries.
 */
export function parseRecipientList(input: string, max = 10): EmailAddress[] {
  const raw = input.trim();

  if (hasControlCharacter(raw)) {
    throw refuse('Address list contains a control character', 'That list has something odd in it.');
  }

  // Split on commas and semicolons, but not inside `<...>` — a display name can
  // legitimately contain a comma ("Chen, Alice <alice@x.com>") and splitting it
  // would produce two unparseable fragments out of one valid recipient.
  const parts = splitAddresses(raw).filter((part) => part.trim().length > 0);

  if (parts.length === 0) {
    throw refuse('No addresses given', 'Who should I send it to?');
  }

  if (parts.length > max) {
    throw refuse(
      `Too many recipients: ${parts.length}`,
      `That is ${parts.length} recipients — I can send to at most ${max} at once.`,
    );
  }

  const seen = new Set<string>();
  const recipients: EmailAddress[] = [];

  for (const part of parts) {
    const recipient = parseRecipient(part);

    // De-duplicated case-insensitively, which deliberately differs from the
    // delivery rule above. `parseRecipient` preserves local-part case because
    // the receiving server owns its meaning and lowercasing could in principle
    // break delivery; here the question is different — whether two entries a
    // person typed mean the same person. `a@x.com` and `A@x.com` effectively
    // always do, and the harm of treating them as one (a rare mailbox that
    // really does distinguish them gets one copy instead of two, and the user
    // can send again) is smaller than the harm of not (someone visibly listed
    // twice on an email they can see the headers of).
    const key = recipient.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(recipient);
  }

  return recipients;
}

/**
 * Whether text looks like it was *meant* to be an address.
 *
 * Used to tell "the user typed a recipient badly" from "the user typed
 * something that was never an address", so the first gets a correction and the
 * second gets a different question. Deliberately loose — it is a routing
 * decision about what to say, never a decision about whether to send.
 */
export function looksLikeAddress(input: string): boolean {
  return /\S@\S/.test(input.trim());
}

/**
 * Splits on separators that are actually separators.
 *
 * A comma inside a display name is not one, and there are two ways a display
 * name can contain one: quoted (`"Chen, Alice" <a@x.com>`) and bracketed. Both
 * have to be tracked, because splitting on either produces two unparseable
 * fragments out of one perfectly valid recipient — and the user gets told their
 * address is invalid when it was the parser that was.
 */
function splitAddresses(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;

  for (const char of input) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') depth += 1;
    else if (!quoted && char === '>') depth = Math.max(0, depth - 1);

    if ((char === ',' || char === ';') && depth === 0 && !quoted) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts;
}

function lowercaseDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

function clamp(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

function refuse(message: string, publicMessage: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { retryable: false, publicMessage });
}
