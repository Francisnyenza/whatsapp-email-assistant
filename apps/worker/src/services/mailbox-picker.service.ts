import { Injectable } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Which mailbox an email goes out from.
 *
 * Irrelevant with one mailbox connected and decisive with two. The address in
 * the `From:` header is the identity the recipient sees and replies to, and
 * sending a work email from a personal address is not something the sender can
 * take back — the reply lands in the wrong inbox and the recipient now has an
 * address they were not given.
 *
 * Until now `ComposeComposer` always used `loadPrimary`, and nothing anywhere
 * told the user which one that was.
 *
 * Matching is deliberately conservative. A hint that matches nothing is a
 * refusal that names the options, and a hint that matches *two* mailboxes is
 * also a refusal — picking one would be a coin flip on the user's identity.
 */
export interface MailboxChoice {
  id: string;
  emailAddress: string;
  displayName: string | null;
  isPrimary: boolean;
}

@Injectable()
export class MailboxPickerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every mailbox the user can send from, primary first. */
  async list(userId: string): Promise<MailboxChoice[]> {
    return this.prisma.forUser(userId, async (tx) =>
      tx.emailAccount.findMany({
        where: { disconnectedAt: null, status: 'active' },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, emailAddress: true, displayName: true, isPrimary: true },
      }),
    );
  }

  /**
   * The mailbox to send from.
   *
   * @param hint what the user said after "from" — a nickname, an address, or
   *   part of either. Absent means the primary, which is the deterministic
   *   answer rather than "whichever came back first".
   */
  async pick(userId: string, hint?: string): Promise<MailboxChoice> {
    const accounts = await this.list(userId);

    if (accounts.length === 0) {
      throw new AppError('NOT_FOUND', 'No connected mailbox to send from', {
        retryable: false,
        publicMessage: "You haven't connected a mailbox yet, so there's nothing to send from.",
      });
    }

    const wanted = hint?.trim().toLowerCase();
    if (!wanted) return accounts[0]!;

    const matches = accounts.filter((account) => matchesHint(account, wanted));

    if (matches.length === 1) return matches[0]!;

    if (matches.length === 0) {
      throw new AppError('NOT_FOUND', 'No mailbox matches that name', {
        retryable: false,
        publicMessage: `I don't have a mailbox called “${hint!.trim()}”. ${describe(accounts)}`,
      });
    }

    // Two mailboxes answer to the same word. Choosing between them would be a
    // coin flip on which identity the recipient sees.
    throw new AppError('CONFLICT', 'Mailbox hint is ambiguous', {
      retryable: false,
      publicMessage: `“${hint!.trim()}” matches more than one. ${describe(matches)}`,
    });
  }
}

/**
 * Whether a mailbox answers to what the user said.
 *
 * Four ways, in decreasing obviousness: the nickname they gave it, the whole
 * address, the part before the @, and the part after. "work" matches a mailbox
 * named Work; "acme" matches me@acme.com, which is how most people refer to
 * one they never nicknamed.
 */
function matchesHint(account: MailboxChoice, wanted: string): boolean {
  const address = account.emailAddress.toLowerCase();
  const [local = '', domain = ''] = address.split('@');

  return (
    (account.displayName?.toLowerCase().includes(wanted) ?? false) ||
    address === wanted ||
    local === wanted ||
    domain === wanted ||
    domain.split('.')[0] === wanted
  );
}

/** Names the mailboxes, so a refusal is a typo the user can fix in one message. */
function describe(accounts: MailboxChoice[]): string {
  const names = accounts.map((account) =>
    account.displayName ? `${account.displayName} (${account.emailAddress})` : account.emailAddress,
  );

  return `You have: ${names.join(', ')}.`;
}
