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
  /** Wait for the user to type their reply. */
  | { kind: 'await_reply_text' }
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

    // --- not built yet --------------------------------------------------------
    case 'confirm_send':
      // Reached only from the forward confirmation, and forwarding has no
      // composer yet. Saying so beats a button that silently does nothing.
      return { kind: 'unavailable', capability: 'forward emails' };

    case 'forward':
      return { kind: 'unavailable', capability: 'forward emails' };

    case 'summarize':
      return { kind: 'unavailable', capability: 'summarise emails' };

    case 'translate':
      return { kind: 'unavailable', capability: 'translate emails' };

    case 'read_aloud':
      return { kind: 'unavailable', capability: 'read emails aloud' };

    case 'undo':
      return { kind: 'unavailable', capability: 'undo things' };

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
