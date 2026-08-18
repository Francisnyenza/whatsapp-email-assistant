import type { ActionPayload, MailOperation } from '@wea/shared';
import { YES_BODY, NO_BODY } from './canned-replies.js';

/**
 * What a button press means.
 *
 * A tap is not a message to be understood — it is an authorization. The id came
 * from a button we minted, carrying our own record id, so there is nothing to
 * infer and nothing an email could have influenced (ADR 0004). This file is the
 * whole mapping from a tapped verb to the thing that happens, and it is pure so
 * the table can be read and tested as a table.
 *
 * The distinction that matters is between a verb and its confirmation.
 * `delete` is the button on a notification card: tapping it asks. Only
 * `confirm_delete` — a button that exists solely on the confirmation we just
 * sent — actually deletes. A user who taps the card's delete button by accident
 * has lost nothing.
 */
export type TapEffect =
  /** Apply an operation to the target message, then say so. */
  | { kind: 'mutate'; operation: MailOperation; confirmation: string }
  /** Send a canned reply. */
  | { kind: 'reply'; body: string }
  /** Ask before acting. The planner builds the prompt. */
  | { kind: 'confirm'; verb: 'delete' }
  /** Carry out whatever the user was asked to confirm sending. */
  | { kind: 'confirm_send' }
  /** Wait for the user to type their reply. */
  | { kind: 'await_reply_text' }
  /**
   * Take back the last action.
   *
   * Carries no target, deliberately: what an undo reverses is whatever was last
   * done, not whatever email the button happened to be attached to.
   */
  | { kind: 'undo' }
  /** Nothing happens; say the given line. */
  | { kind: 'acknowledge'; message: string }
  /** A verb whose feature is not built. */
  | { kind: 'unavailable'; capability: string };

export function interpretTap(payload: ActionPayload): TapEffect {
  switch (payload.action) {
    // --- authorizations: the confirmation button was pressed ----------------
    case 'confirm_delete':
      return {
        kind: 'mutate',
        operation: { kind: 'delete', permanent: false },
        confirmation: 'Deleted. It is in your trash if you need it back.',
      };

    // --- reversible, so the tap itself is enough ----------------------------
    case 'archive':
      return {
        kind: 'mutate',
        operation: { kind: 'archive' },
        confirmation: 'Archived.',
      };

    case 'mark_read':
      return {
        kind: 'mutate',
        operation: { kind: 'markRead', read: true },
        confirmation: 'Marked as read.',
      };

    case 'mark_important':
      return {
        kind: 'mutate',
        operation: { kind: 'star', starred: true },
        confirmation: 'Starred.',
      };

    // --- destructive: ask, never act ----------------------------------------
    case 'delete':
      return { kind: 'confirm', verb: 'delete' };

    // --- replying ------------------------------------------------------------
    case 'reply':
      return { kind: 'await_reply_text' };

    case 'reply_yes':
      return { kind: 'reply', body: YES_BODY };

    case 'reply_no':
      return { kind: 'reply', body: NO_BODY };

    case 'cancel':
      return { kind: 'acknowledge', message: 'Cancelled. Nothing was sent.' };

    // --- selecting a row from a disambiguation list --------------------------
    case 'open_thread':
      // The tap already resolved which email is meant; that is recorded as the
      // active conversation by the caller. All that is left is to invite the
      // next instruction.
      return {
        kind: 'acknowledge',
        message: 'Got it. What would you like to do — *reply*, *archive*, or *delete*?',
      };

    case 'confirm_send':
      // What is being sent is deliberately not in this payload — not the
      // recipient of a forward, not the words of a drafted reply. Both were
      // written to the conversation's pending action when the user asked, so a
      // replayed or crafted tap can only re-authorize what they already read.
      // It cannot redirect their mail somewhere new, and it cannot put
      // different words in their mouth.
      return { kind: 'confirm_send' };

    // --- not built yet --------------------------------------------------------
    case 'forward':
      // The card has no forward button today; a typed command is the only way
      // in, because a forward needs a recipient and a button cannot ask for one.
      return { kind: 'unavailable', capability: 'forward from a button' };

    // --- built, but not reachable from a button -------------------------------
    // All three work when typed, and no card emits these ids today, so these
    // branches are unreachable in practice. What they must not say is "that
    // part isn't finished": it is false, and it would talk a user out of a
    // feature they already have.
    case 'summarize':
      return { kind: 'acknowledge', message: 'Type _summarise_ and I’ll do it.' };

    case 'translate':
      return { kind: 'acknowledge', message: 'Type _translate to spanish_ — any language works.' };

    case 'read_aloud':
      return { kind: 'acknowledge', message: 'Type _read it aloud_ and I’ll record it.' };

    case 'undo':
      // The button and the typed word do the same thing, and both read the same
      // record. The target id on the payload is deliberately ignored: what an
      // undo reverses is whatever the last action was, not whatever email the
      // button happened to be attached to.
      return { kind: 'undo' };

    // --- not built yet --------------------------------------------------------
    case 'more':
      return { kind: 'unavailable', capability: 'show more' };

    default: {
      // Exhaustiveness: adding a PayloadAction without a case here stops
      // compiling rather than silently becoming a dead button.
      const unreachable: never = payload.action;
      return { kind: 'acknowledge', message: `I didn't recognise that: ${String(unreachable)}` };
    }
  }
}
