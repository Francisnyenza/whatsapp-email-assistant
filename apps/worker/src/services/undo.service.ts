import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, type MailOperation } from '@wea/shared';
import { InboxRepository } from '../repositories/inbox.repository.js';
import { MailboxActionService } from './mailbox-action.service.js';
import { LabelService } from './label.service.js';
import { SnoozeService } from './snooze.service.js';

/**
 * Taking back the last thing you did.
 *
 * `undo` has been a parsed intent since the command parser was written and a
 * button action since the payload codec was, and both answered "not built" —
 * because nothing anywhere remembered what had just happened.
 *
 * Three rules decide what this class is allowed to do:
 *
 *  1. **Only the last action, and only recently.** One slot, not a stack. Mail
 *     clients offer exactly one level, and a deeper history invites walking
 *     backwards through changes the mailbox has since had synced over it from
 *     another device.
 *  2. **Say plainly what cannot be undone.** A sent reply is gone; the recipient
 *     has it. "Nothing to undo" in that moment reads as a bug, and the user
 *     spends the next minute wondering whether the mail went. Naming the reason
 *     is the whole difference.
 *  3. **Reverse through the same path that acted.** The inverse goes back
 *     through `MailboxActionService`, so the provider is the source of truth for
 *     the undo exactly as it was for the action, and the local mirror follows.
 */

/** How long "undo" still means the last thing. */
export const UNDO_WINDOW_MS = 10 * 60_000;

/** What was done, in enough detail to reverse it. */
export interface UndoableAction {
  emailMessageId: string;
  /** The verb as the user's command named it, which is what the message says back. */
  verb: string;
  /** The inverse, ready to apply. Absent for a snooze, which is undone differently. */
  operation?: MailOperation;
  /** For a label change: the names to put back, as the mailbox spells them. */
  labels?: { add?: string[]; remove?: string[] };
  /** True for a snooze, whose inverse is cancelling the reminder. */
  snooze?: boolean;
  /**
   * Recorded for something that *cannot* be taken back — a sent reply, a
   * forward, a compose.
   *
   * Deliberately recorded rather than skipped. "Nothing to undo" a second after
   * sending reads as a bug, and the user spends the next minute wondering
   * whether the mail actually went; naming the reason is the whole difference.
   */
  irreversible?: boolean;
}

@Injectable()
export class UndoService {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly mailbox: MailboxActionService,
    private readonly labels: LabelService,
    private readonly snoozes: SnoozeService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Records what just happened, so the next "undo" has something to reverse.
   *
   * Called after the action succeeded, never before: an undo offered for
   * something that did not happen would reverse a state the mailbox is not in.
   */
  async record(userId: string, action: UndoableAction): Promise<void> {
    await this.inbox
      .setLastAction(userId, { ...action, at: new Date().toISOString() })
      .catch((err: unknown) => {
        // Losing the undo record costs the user an undo. Failing their actual
        // command over it would cost them the command.
        this.logger.warn(
          { event: 'undo.record_failed', verb: action.verb, err },
          'Could not record an undoable action',
        );
      });
  }

  /**
   * Reverses it.
   *
   * @returns a sentence describing what was put back.
   * @throws {AppError} when there is nothing to undo, or when what was done
   *   cannot be taken back — with the reason, which is the part that matters.
   */
  async undo(userId: string, now = new Date()): Promise<string> {
    const record = await this.inbox.takeLastAction(userId);

    if (!record) {
      throw new AppError('NOT_FOUND', 'Nothing to undo', {
        retryable: false,
        publicMessage: "There's nothing to undo right now.",
      });
    }

    const at = typeof record.at === 'string' ? Date.parse(record.at) : NaN;
    if (!Number.isFinite(at) || now.getTime() - at > UNDO_WINDOW_MS) {
      throw new AppError('CONFLICT', 'Undo window has passed', {
        retryable: false,
        publicMessage:
          "That was a while ago, so I've stopped holding on to it. " +
          'Tell me what to change and I’ll do it directly.',
      });
    }

    const action = record as unknown as UndoableAction;

    if (action.irreversible) {
      throw new AppError('CONFLICT', 'Action cannot be undone', {
        retryable: false,
        publicMessage:
          "I can't unsend an email — that one has already gone. " +
          'If it needs correcting, send a follow-up and I’ll thread it onto the same conversation.',
      });
    }

    if (action.snooze) {
      await this.snoozes.cancelFor(userId, action.emailMessageId);
      await this.mailbox.apply(userId, action.emailMessageId, { kind: 'unarchive' });
      this.logger.info({ event: 'undo.applied', verb: action.verb }, 'Action undone');
      return "Back in your inbox, and I've forgotten the snooze.";
    }

    if (action.labels) {
      const result = await this.labels.apply(userId, action.emailMessageId, action.labels);
      this.logger.info({ event: 'undo.applied', verb: action.verb }, 'Action undone');
      return result.removed.length
        ? `Took *${result.removed.join('*, *')}* back off.`
        : `Put *${result.added.join('*, *')}* back on.`;
    }

    if (!action.operation) {
      throw new AppError('BAD_REQUEST', 'Recorded action has no inverse', {
        retryable: false,
        publicMessage: "I can't undo that one.",
      });
    }

    await this.mailbox.apply(userId, action.emailMessageId, action.operation);

    this.logger.info(
      { event: 'undo.applied', verb: action.verb, inverse: action.operation.kind },
      'Action undone',
    );

    return describeUndo(action.verb);
  }
}

/**
 * The inverse of what a command did, or null when there is not one.
 *
 * Null is a real answer here rather than an omission. A sent reply, a forward
 * and a compose have all left the building, and the honest response to "undo" is
 * to say so — which the caller can only do if this refuses to invent an inverse.
 */
export function inverseOf(operation: MailOperation): MailOperation | null {
  switch (operation.kind) {
    case 'archive':
      return { kind: 'unarchive' };
    case 'unarchive':
      return { kind: 'archive' };
    case 'delete':
      // A permanent delete has no inverse, which is why nothing reachable from a
      // chat performs one.
      return operation.permanent ? null : { kind: 'restore' };
    case 'restore':
      return { kind: 'delete', permanent: false };
    case 'markRead':
      return { kind: 'markRead', read: !operation.read };
    case 'star':
      return { kind: 'star', starred: !operation.starred };
    case 'spam':
      return { kind: 'spam', isSpam: !operation.isSpam };
    case 'label':
      // Labels are undone by name through `LabelService`, not by id here: the
      // ids came from a directory lookup, and reversing them means resolving
      // against the same one.
      return null;
  }
}

/** What to say once it is done, in the terms the user used. */
function describeUndo(verb: string): string {
  switch (verb) {
    case 'archive':
      return "Back in your inbox — that's undone.";
    case 'delete':
      return "Out of the trash and back in your inbox — that's undone.";
    case 'spam':
      return 'Out of spam and back in your inbox.';
    case 'not_spam':
      return 'Back in spam.';
    case 'mark_read':
      return "Marked unread again — that's undone.";
    case 'mark_unread':
      return "Marked read again — that's undone.";
    case 'star':
      return 'Unstarred.';
    case 'unstar':
      return 'Starred again.';
    default:
      return "That's undone.";
  }
}
