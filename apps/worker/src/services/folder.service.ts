import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, type MailFolder } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';
import { AccountService } from './account.service.js';
import { MailboxActionService } from './mailbox-action.service.js';

/**
 * Putting a message somewhere.
 *
 * The two mailboxes mean genuinely different things by "move", and this is
 * where that stops mattering to anything above it. Outlook has folders, and a
 * message is in exactly one. Gmail has none at all — its own "Move to" applies
 * a label and drops the message out of the inbox, which is what a move means
 * there.
 *
 * The asymmetry with `LabelService` is deliberate and worth stating: adding an
 * unknown *label* creates it, and moving to an unknown *folder* refuses. A label
 * leaves the message where it is, so a typo is visible and harmless. A move
 * takes it out of the inbox — putting it in a folder that did not exist a second
 * ago means the user cannot find it in the folder list they know, and the mail
 * is gone as far as they can tell.
 */
@Injectable()
export class FolderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    private readonly mailbox: MailboxActionService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * @returns the destination as the mailbox spells it, which is what the user is
   *   told — matching is case-insensitive, so "receipts" lands in an existing
   *   "Receipts" rather than failing over a capital letter.
   */
  async move(userId: string, emailMessageId: string, destination: string): Promise<string> {
    const account = await this.accountFor(userId, emailMessageId);
    const provider = this.accounts.providerFor(account.provider);

    const folders = await provider.listFolders(account);
    const wanted = destination.trim().toLowerCase();

    const match =
      folders.find((folder) => folder.name.toLowerCase() === wanted) ??
      // A nested folder can be named by its last segment when only one answers
      // to it: "move it to 2026" is unambiguous until two clients have one.
      onlyOne(folders.filter((folder) => lastSegment(folder.name) === wanted));

    if (!match) {
      throw new AppError('NOT_FOUND', 'No such folder', {
        retryable: false,
        publicMessage: describeMissing(destination, folders),
      });
    }

    await this.mailbox.apply(userId, emailMessageId, {
      kind: 'move',
      destinationId: match.id,
    });

    this.logger.info(
      // The folder name is the user's own vocabulary about their own mail, so it
      // stays out of the log for the same reason a filename does.
      { event: 'folder.moved', emailMessageId, accountId: account.id },
      'Message moved',
    );

    return match.name;
  }

  /** The mailbox's own folders, for "what folders do I have". */
  async list(userId: string): Promise<string[]> {
    const account = await this.accounts.loadPrimary(userId);
    const provider = this.accounts.providerFor(account.provider);

    const folders = await provider.listFolders(account);
    return folders.map((folder) => folder.name).sort((a, b) => a.localeCompare(b));
  }

  /**
   * The mailbox this message lives in.
   *
   * A folder belongs to one account, exactly as a label does: moving a Gmail
   * message into a folder that exists only in the user's Outlook mailbox is
   * meaningless, and resolving against the primary would do that for anyone with
   * two connected.
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

/** The name without its parents: `Clients/2026` → `2026`. */
function lastSegment(name: string): string {
  return name.split('/').at(-1)!.toLowerCase();
}

/** One match is an answer; two is an ambiguity the caller must not resolve. */
function onlyOne(matches: MailFolder[]): MailFolder | undefined {
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * What to say when the folder does not exist.
 *
 * Naming the ones that do is the difference between a dead end and a typo the
 * user fixes in one message — and it matters more here than for a label,
 * because the alternative to listing them is the user guessing at the name of a
 * place their mail would then disappear into.
 */
function describeMissing(name: string, folders: MailFolder[]): string {
  if (folders.length === 0) {
    return `I couldn't find a folder called “${name}”, or any folders at all in that mailbox.`;
  }

  const names = folders
    .map((folder) => folder.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LISTED);

  const more = folders.length > MAX_LISTED ? `, and ${folders.length - MAX_LISTED} more` : '';

  return `You don't have a folder called “${name}”. You have: ${names.join(', ')}${more}.`;
}

/** A WhatsApp message is not a folder tree; ten names is already a lot. */
const MAX_LISTED = 10;
