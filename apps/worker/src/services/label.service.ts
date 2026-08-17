import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, type MailLabel } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';
import { AccountService } from './account.service.js';
import { MailboxActionService } from './mailbox-action.service.js';

/**
 * Filing mail under a name the user chose.
 *
 * The `label` operation has been implemented in both adapters since Phase 7 and
 * was unreachable, but wiring a verb to it is not enough on its own, because the
 * two providers disagree about what a label is. Gmail's `addLabelIds` takes ids
 * and silently ignores names; Outlook's categories *are* names and have no ids.
 * A command that passed the user's words straight through would work against one
 * mailbox and no-op against the other, which is the worst of the three possible
 * outcomes — the user is told it worked and finds nothing filed.
 *
 * So a name is resolved against the mailbox's own list before anything is
 * applied, and the two directions are deliberately asymmetric:
 *
 *  * **Adding** an unknown name creates it. That is what every mail client does,
 *    and refusing would mean the user has to leave the chat to make a label
 *    before they can use one.
 *  * **Removing** an unknown name refuses, and says which labels exist. A remove
 *    that silently succeeds against a label the mailbox never had is a claim
 *    that something was unfiled when nothing was.
 */
@Injectable()
export class LabelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly mailbox: MailboxActionService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Applies a label change to one message, by name.
   *
   * @returns the names as the mailbox spells them, which is what the user is
   *   told — matching is case-insensitive, so "receipts" files under an existing
   *   "Receipts" rather than creating a second one beside it.
   */
  async apply(
    userId: string,
    emailMessageId: string,
    change: { add?: string[]; remove?: string[] },
  ): Promise<{ added: string[]; removed: string[] }> {
    const account = await this.accountFor(userId, emailMessageId);
    const provider = this.accounts.providerFor(account.provider);

    const existing = await provider.listLabels(account);
    const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));

    const added: MailLabel[] = [];
    for (const name of change.add ?? []) {
      const found = byName.get(name.toLowerCase());
      if (found) {
        added.push(found);
        continue;
      }

      const created = await provider.createLabel(account, name);
      byName.set(created.name.toLowerCase(), created);
      added.push(created);

      this.logger.info(
        // The label name is the user's own vocabulary about their own mail, so
        // it stays out of the log for the same reason a filename does.
        { event: 'label.created', accountId: account.id },
        'Created a label the mailbox did not have',
      );
    }

    const removed: MailLabel[] = [];
    for (const name of change.remove ?? []) {
      const found = byName.get(name.toLowerCase());
      if (!found) {
        throw new AppError('NOT_FOUND', 'No such label', {
          retryable: false,
          publicMessage: describeMissing(name, existing),
        });
      }
      removed.push(found);
    }

    if (added.length === 0 && removed.length === 0) {
      throw new AppError('BAD_REQUEST', 'Nothing to file', {
        retryable: false,
        publicMessage: 'Which label? Try _label this as Receipts_.',
      });
    }

    await this.mailbox.apply(userId, emailMessageId, {
      kind: 'label',
      // Ids, always. Passing names here is exactly the mistake this class
      // exists to make impossible — against Gmail it is a silent no-op.
      ...(added.length ? { add: added.map((l) => l.id) } : {}),
      ...(removed.length ? { remove: removed.map((l) => l.id) } : {}),
    });

    return { added: added.map((l) => l.name), removed: removed.map((l) => l.name) };
  }

  /** The mailbox's own filing names, for "what labels do I have". */
  async list(userId: string): Promise<string[]> {
    const account = await this.accounts.loadPrimary(userId);
    const provider = this.accounts.providerFor(account.provider);

    const labels = await provider.listLabels(account);
    return labels.map((label) => label.name).sort((a, b) => a.localeCompare(b));
  }

  /**
   * The mailbox this message lives in.
   *
   * A label belongs to one account, not to the user: filing a Gmail message
   * under a category that exists only in their Outlook mailbox is meaningless,
   * and resolving against the primary account would do exactly that for anyone
   * with two mailboxes connected.
   */
  private async accountFor(userId: string, emailMessageId: string) {
    const message = await this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: { accountId: true, deletedAt: true },
      }),
    );

    if (!message || message.deletedAt) {
      throw new AppError('NOT_FOUND', 'That email is no longer available', { retryable: false });
    }

    return this.accounts.load(userId, message.accountId);
  }
}

/**
 * What to say when a label the user named does not exist.
 *
 * Naming the ones that do is the difference between a dead end and a typo the
 * user can fix in one message.
 */
function describeMissing(name: string, existing: MailLabel[]): string {
  if (existing.length === 0) {
    return `You don't have a label called “${name}” — or any labels yet.`;
  }

  const names = existing
    .map((label) => label.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LISTED);

  const more = existing.length > MAX_LISTED ? `, and ${existing.length - MAX_LISTED} more` : '';

  return `You don't have a label called “${name}”. You have: ${names.join(', ')}${more}.`;
}

/** A WhatsApp message is not a list view; twenty names is already too many. */
const MAX_LISTED = 10;
