import type { EmailAddress } from '@wea/shared';
import { formatRfc2822Date } from './mime-builder.js';

/**
 * Composing a forward.
 *
 * A forward is not a reply with a different recipient. It starts its own
 * conversation, so it carries no `In-Reply-To` and no `References`: threading it
 * onto the original would drop the forwarded copy into the sender's thread in
 * the recipient's client, which is both confusing and a small leak — it tells
 * the new recipient that the conversation continued elsewhere.
 *
 * The quoted block is the convention every mail client renders and every reader
 * recognises. Reproducing it exactly is what keeps the promise that the
 * recipient sees an ordinary forwarded email, with nothing about it suggesting
 * a phone or an intermediary.
 */

export interface ForwardSource {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  sentAt: Date;
  /** The original body. Empty is legitimate — plenty of mail is subject-only. */
  bodyText: string;
}

/**
 * The forwarded-message block.
 *
 * `note` is whatever the user typed alongside the command, and it goes *above*
 * the quote — where a person writing the same forward by hand would put it, and
 * where the recipient reads it first.
 */
export function buildForwardBody(source: ForwardSource, note?: string): string {
  const lines: string[] = [];

  const trimmedNote = note?.trim();
  if (trimmedNote) {
    lines.push(trimmedNote, '');
  }

  lines.push('---------- Forwarded message ----------');
  lines.push(`From: ${formatAddress(source.from)}`);
  lines.push(`Date: ${formatRfc2822Date(source.sentAt)}`);
  lines.push(`Subject: ${source.subject}`);
  lines.push(`To: ${source.to.map(formatAddress).join(', ')}`);
  if (source.cc?.length) {
    lines.push(`Cc: ${source.cc.map(formatAddress).join(', ')}`);
  }
  lines.push('');
  lines.push(source.bodyText);

  return lines.join('\n');
}

/**
 * A display name and address for the quoted block.
 *
 * Deliberately not the header formatter from `mime-builder`. That one throws on
 * anything that would break a header, which is right for a header and wrong
 * here: these values are the *original sender's* chosen display name, so a
 * malformed one must degrade into safe body text rather than fail the whole
 * forward. Newlines are stripped because a display name of
 * `Alice\nFrom: ceo@corp.com` would otherwise forge a convincing extra line
 * inside the quoted block.
 */
function formatAddress(address: EmailAddress): string {
  if (!address.name) return address.address;
  const name = address.name.replace(/[\r\n]+/g, ' ').trim();
  if (!name) return address.address;
  return /["<>,:;@\\]/.test(name)
    ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address.address}>`
    : `${name} <${address.address}>`;
}
