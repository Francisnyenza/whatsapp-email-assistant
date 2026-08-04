import { Injectable } from '@nestjs/common';
import { decodeActionPayload, type InboundWhatsAppMessage } from '@wea/shared';

/**
 * Working out which email a WhatsApp message is about.
 *
 * This is the ladder from ADR 0003, and the single most consequential decision
 * in the product. A misrouted reply sends someone's words to the wrong person —
 * unrecoverable, and far worse than one extra round trip asking.
 *
 * So the ladder descends by confidence and **ends in a question, never a
 * guess**. Ranks 1 and 2 are certain because they come from identifiers we
 * minted ourselves. Rank 3 is strong but time-bounded. Rank 4 is a fuzzy match
 * and only accepted when exactly one candidate stands out. Rank 5 asks.
 */

export type ResolutionRank = 1 | 2 | 3 | 4 | 5;

export interface ResolutionCandidate {
  emailMessageId: string;
  fromAddress: string;
  fromName?: string;
  subject: string;
  receivedAt: Date;
  /** Display names the user has previously used for this correspondent. */
  aliases?: string[];
}

export type Resolution =
  | {
      outcome: 'resolved';
      emailMessageId: string;
      rank: ResolutionRank;
      /** Why we believe this, for the audit log and for debugging misroutes. */
      basis: string;
    }
  | {
      outcome: 'ambiguous';
      /** Presented as a numbered list; the user picks. */
      options: ResolutionCandidate[];
      basis: string;
    }
  | { outcome: 'none'; basis: string };

export interface ResolutionContext {
  /** Our delivery records: Meta's wamid → the email it notified about. */
  deliveryLookup: (whatsappMessageId: string) => Promise<string | null>;
  /** The active conversation state, if any. */
  activeEmailMessageId?: string | null;
  activeStateExpiresAt?: Date | null;
  /** Recently notified emails, newest first. Bounded by the caller. */
  recent: ResolutionCandidate[];
  /** A named target parsed from the command, e.g. "Sarah" or an address. */
  namedTarget?: string;
  now?: Date;
}

@Injectable()
export class ThreadResolver {
  async resolve(message: InboundWhatsAppMessage, context: ResolutionContext): Promise<Resolution> {
    const now = context.now ?? new Date();

    // --- Rank 1: the user used WhatsApp's native reply -------------------
    // Certain. They pointed at a specific message of ours, and that message
    // maps to exactly one email.
    if (message.context?.id) {
      const emailMessageId = await context.deliveryLookup(message.context.id);
      if (emailMessageId) {
        return {
          outcome: 'resolved',
          emailMessageId,
          rank: 1,
          basis: 'replied directly to our notification',
        };
      }
      // The reply pointed at something we cannot map — an old message past
      // retention, or a message we did not send. Fall through rather than
      // guessing, because the user clearly had a *specific* email in mind and
      // picking a different one would be the worst possible outcome.
    }

    // --- Rank 2: a button or list row we minted --------------------------
    // Also certain: the payload carries our own record id, which is what makes
    // a tap an authorization rather than a hint (ADR 0004).
    if (message.interactive?.id) {
      const payload = decodeActionPayload(message.interactive.id);
      if (payload) {
        return {
          outcome: 'resolved',
          emailMessageId: payload.targetId,
          rank: 2,
          basis: `tapped ${payload.action}`,
        };
      }
    }

    // --- Rank 3: an active conversation ----------------------------------
    // Strong, but only while the state is live. An expired context means the
    // user has probably moved on, and "reply yes" half an hour later may well
    // concern something else entirely.
    if (context.activeEmailMessageId) {
      const expired =
        context.activeStateExpiresAt !== null &&
        context.activeStateExpiresAt !== undefined &&
        context.activeStateExpiresAt.getTime() <= now.getTime();

      if (!expired) {
        return {
          outcome: 'resolved',
          emailMessageId: context.activeEmailMessageId,
          rank: 3,
          basis: 'continuing the current conversation',
        };
      }
    }

    // --- Rank 4: a named target ------------------------------------------
    // "reply to Sarah". Accepted only when the name picks out exactly one
    // correspondent; two Sarahs is a question, not a coin flip.
    if (context.namedTarget) {
      const matches = matchByName(context.namedTarget, context.recent);

      if (matches.length === 1) {
        return {
          outcome: 'resolved',
          emailMessageId: matches[0]!.emailMessageId,
          rank: 4,
          basis: `matched "${context.namedTarget}" to one correspondent`,
        };
      }
      if (matches.length > 1) {
        return {
          outcome: 'ambiguous',
          options: matches.slice(0, 10),
          basis: `"${context.namedTarget}" matched ${matches.length} correspondents`,
        };
      }
      // Named someone we cannot find. Offering the full recent list would be
      // misleading — they asked for a specific person.
      return { outcome: 'none', basis: `no recent email from "${context.namedTarget}"` };
    }

    // --- Rank 5: ask -----------------------------------------------------
    if (context.recent.length === 0) {
      return { outcome: 'none', basis: 'no recent emails to reply to' };
    }

    // Exactly one recent email is not the same as certainty, but it is the only
    // thing the user could plausibly mean, and asking would be pedantic.
    if (context.recent.length === 1) {
      return {
        outcome: 'resolved',
        emailMessageId: context.recent[0]!.emailMessageId,
        rank: 4,
        basis: 'only one recent email',
      };
    }

    return {
      outcome: 'ambiguous',
      options: context.recent.slice(0, 10),
      basis: 'nothing identified which email was meant',
    };
  }
}

/**
 * Matches a user-typed name against recent correspondents.
 *
 * Deliberately conservative. It matches a full address, a stored alias, a whole
 * display name, or a whole word within one — but never a bare substring, so
 * "sam" does not match "Samantha" and quietly reply to the wrong person.
 */
export function matchByName(
  target: string,
  candidates: ResolutionCandidate[],
): ResolutionCandidate[] {
  const needle = target.trim().toLowerCase();
  if (!needle) return [];

  const byEmail = new Map<string, ResolutionCandidate>();

  for (const candidate of candidates) {
    const address = candidate.fromAddress.toLowerCase();
    const name = (candidate.fromName ?? '').toLowerCase();
    const aliases = (candidate.aliases ?? []).map((a) => a.toLowerCase());

    const hit =
      address === needle ||
      aliases.includes(needle) ||
      name === needle ||
      // Whole-word match inside a display name: "sarah" matches "Sarah Chen".
      name.split(/\s+/).includes(needle) ||
      // Or the local part of the address: "sarah" matches sarah@acme.com.
      address.split('@')[0] === needle;

    // One entry per correspondent — three emails from Sarah is one Sarah, and
    // presenting the same person three times as "ambiguous" would be absurd.
    if (hit && !byEmail.has(address)) byEmail.set(address, candidate);
  }

  return [...byEmail.values()];
}
