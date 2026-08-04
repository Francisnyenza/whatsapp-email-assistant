import type { EmailAddress, NormalizedMessage } from '@wea/shared';

/**
 * RFC 5322 threading.
 *
 * This is the product. A reply typed in WhatsApp has to land inside the
 * recipient's existing conversation, in Gmail, Outlook, Apple Mail and
 * Thunderbird alike — and every one of them threads on these headers alone.
 * Get `References` wrong and the reply detaches into a new conversation, which
 * is immediately visible to the person we are trying not to surprise.
 *
 * Everything here is pure and synchronous, which is deliberate: the rules are
 * fiddly enough that they deserve to be tested exhaustively without a network.
 */

/** Practical ceiling for a header line before agents start folding or truncating. */
const MAX_REFERENCES_LENGTH = 900;
/** Keep at least this many of the most recent ancestors when trimming. */
const KEEP_RECENT = 5;

export interface ThreadHeaders {
  inReplyTo: string;
  references: string[];
  subject: string;
}

/**
 * Builds the threading headers for a reply to `original`.
 *
 * The three rules, each of which clients actually depend on:
 *
 *  1. `In-Reply-To` is the parent's `Message-ID`, alone.
 *  2. `References` is the parent's `References` plus the parent's `Message-ID`,
 *     oldest first. Clients walk this to place the message in a tree.
 *  3. `Subject` gets exactly one `Re: `, never a stack of them.
 */
export function buildReplyHeaders(original: {
  messageIdHeader: string;
  references: string[];
  subject: string;
}): ThreadHeaders {
  const parentId = normalizeMessageId(original.messageIdHeader);

  // Deduplicate while preserving order: a malformed chain upstream can repeat
  // ids, and repeating them again compounds it.
  const seen = new Set<string>();
  const chain: string[] = [];

  for (const raw of original.references) {
    const id = normalizeMessageId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }

  if (parentId && !seen.has(parentId)) chain.push(parentId);

  return {
    inReplyTo: parentId,
    references: trimReferences(chain),
    subject: buildReplySubject(original.subject),
  };
}

/**
 * Trims an over-long `References` chain from the *middle*.
 *
 * The root anchors the conversation and the most recent ancestors position the
 * new message; the ids in between are the ones no client needs. Dropping from
 * the end — the obvious implementation — is exactly wrong, because it discards
 * the parent.
 */
export function trimReferences(chain: string[]): string[] {
  if (chain.length <= KEEP_RECENT + 1) return chain;

  let result = chain;
  while (result.join(' ').length > MAX_REFERENCES_LENGTH && result.length > KEEP_RECENT + 1) {
    // Keep the first (root) and the last KEEP_RECENT; drop one from just after
    // the root each pass.
    result = [result[0]!, ...result.slice(2)];
  }
  return result;
}

/**
 * Adds `Re: ` exactly once.
 *
 * Recognizes the localized forms that arrive from real mailboxes — `RE:`,
 * `Re :`, `Aw:` (German), `Sv:` (Nordic), `Re[2]:` (some Outlook versions) — so
 * a thread that has crossed several clients does not accumulate a prefix pile.
 */
export function buildReplySubject(subject: string): string {
  const stripped = stripReplyPrefixes(subject);
  return stripped ? `Re: ${stripped}` : 'Re:';
}

export function buildForwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^(fwd?|wg|tr|vs|enc)\s*(\[\d+\])?\s*:/i.test(trimmed)) return trimmed;
  return `Fwd: ${stripReplyPrefixes(subject) || '(no subject)'}`;
}

const PREFIX_RE = /^\s*(re|aw|sv|vs|antw|res|odp|回复|回覆|rif)\s*(\[\d+\])?\s*:\s*/i;

export function stripReplyPrefixes(subject: string): string {
  let result = subject.trim();
  // Bounded: a subject of "Re: Re: Re: …" is a real thing, but an unbounded
  // loop on adversarial input is not acceptable.
  for (let i = 0; i < 10; i++) {
    const next = result.replace(PREFIX_RE, '');
    if (next === result) break;
    result = next;
  }
  return result.trim();
}

/**
 * Normalizes a `Message-ID` to `<id>` form.
 *
 * Providers are inconsistent about the angle brackets: Gmail's API returns them,
 * Graph sometimes does not. An `In-Reply-To` without brackets is malformed and
 * some clients will not match it, so we always add them.
 */
export function normalizeMessageId(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const inner = trimmed.replace(/^<+/, '').replace(/>+$/, '').trim();
  if (!inner) return '';
  return `<${inner}>`;
}

/** Parses a `References` header value into individual ids. */
export function parseReferences(header: string | undefined): string[] {
  if (!header) return [];
  const ids = header.match(/<[^<>\s]+>/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Generates a `Message-ID` for a message we compose ourselves.
 *
 * The domain part is the *user's own* mail domain, never ours. A recipient
 * inspecting headers sees an id consistent with the sending address, exactly as
 * their own client would produce (ADR 0003).
 */
export function generateMessageId(fromAddress: string, randomPart: string): string {
  const at = fromAddress.lastIndexOf('@');
  const domain = at > 0 ? fromAddress.slice(at + 1) : 'localhost';
  return `<${randomPart}@${domain}>`;
}

/* ------------------------------- recipients -------------------------------- */

/**
 * Who a reply goes to.
 *
 * `Reply-To` wins over `From` when present — that is what the header is for, and
 * ignoring it sends mailing-list replies to the wrong place.
 */
export function resolveReplyRecipients(
  original: Pick<NormalizedMessage, 'from' | 'replyTo' | 'to' | 'cc'>,
  selfAddress: string,
  replyAll: boolean,
): { to: EmailAddress[]; cc: EmailAddress[] } {
  const self = selfAddress.trim().toLowerCase();
  const primary = original.replyTo ?? original.from;

  if (!replyAll) return { to: [primary], cc: [] };

  const seen = new Set<string>([self, primary.address.toLowerCase()]);
  const cc: EmailAddress[] = [];

  for (const recipient of [...original.to, ...original.cc]) {
    const address = recipient.address.toLowerCase();
    // Never CC the user their own reply, and never duplicate the primary.
    if (seen.has(address)) continue;
    seen.add(address);
    cc.push(recipient);
  }

  return { to: [primary], cc };
}
