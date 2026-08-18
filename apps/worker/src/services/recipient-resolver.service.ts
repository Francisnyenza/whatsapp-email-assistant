import { Injectable } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { looksLikeAddress } from '@wea/mail';
import { ContactRepository } from '../repositories/contact.repository.js';

/**
 * Turning "sarah" into an address.
 *
 * The riskiest resolution in the product, and the one with the least margin:
 * every other command acts on a message the user was looking at, so a mistake
 * is visible and reversible. This one originates mail to somebody, and the only
 * thing standing between a wrong match and a private message reaching the wrong
 * person is the confirmation — which exists, shows the resolved address, and is
 * the reason this is safe to offer at all.
 *
 * So the rules are deliberately unhelpful where being helpful would be
 * dangerous:
 *
 *  * **Anything that already looks like an address is passed straight through**,
 *    untouched and unmatched. A user who typed an address means that address.
 *  * **A single confident match resolves.** Confident means the name matches a
 *    contact's display name or an alias the user themselves gave.
 *  * **Two matches refuse and list them.** Choosing between two Sarahs by who
 *    writes more often is a guess dressed as a ranking.
 *  * **No match refuses.** It never falls back to "close enough", because the
 *    cost of being wrong is not symmetric with the cost of asking.
 */
@Injectable()
export class RecipientResolverService {
  constructor(private readonly contacts: ContactRepository) {}

  /**
   * @returns the text to hand to `parseRecipientList` — either exactly what the
   *   user typed, or the address of the one person it can only have meant.
   */
  async resolve(userId: string, typed: string): Promise<string> {
    const text = typed.trim();

    // Already an address, or a list of them. Nothing to look up, and looking
    // anyway would risk "correcting" what the user was explicit about.
    if (text.split(/[,;]/).every((part) => looksLikeAddress(part.trim()))) {
      return text;
    }

    // A list mixing names and addresses is more ambiguity than this should
    // resolve in one go; the user is asked to name them plainly.
    if (/[,;]/.test(text)) {
      throw new AppError('BAD_REQUEST', 'Mixed names and addresses', {
        retryable: false,
        publicMessage:
          'I can look up one name at a time. Give me the addresses, or send them one email each.',
      });
    }

    const matches = await this.contacts.findByName(userId, text);

    if (matches.length === 1) return matches[0]!.emailAddress;

    if (matches.length === 0) {
      throw new AppError('NOT_FOUND', 'No contact by that name', {
        retryable: false,
        publicMessage:
          `I don't have an address for “${text}”. ` +
          "Give me the full address once and I'll remember them from their next email.",
      });
    }

    // Two people answer to the same name. Ranking them by who writes more often
    // would be a guess wearing a ranking's clothes.
    const listed = matches
      .slice(0, 4)
      .map((match) =>
        match.displayName ? `${match.displayName} <${match.emailAddress}>` : match.emailAddress,
      )
      .join('\n• ');

    throw new AppError('CONFLICT', 'Several contacts by that name', {
      retryable: false,
      publicMessage: `I know more than one “${text}”:\n• ${listed}\n\nWhich address?`,
    });
  }
}
