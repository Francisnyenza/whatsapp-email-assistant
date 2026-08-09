import { Injectable } from '@nestjs/common';
import {
  encodeActionPayload,
  type CommandIntent,
  type MailOperation,
  type WhatsAppOutboundPayload,
} from '@wea/shared';
import { buildDisambiguation, buildDeleteConfirmation, buildText, clamp } from '@wea/whatsapp';
import type { Resolution, ResolutionCandidate } from './thread-resolver.js';
import { YES_BODY, NO_BODY } from './canned-replies.js';

/**
 * Deciding what to say back.
 *
 * Pure by design — it takes an intent and a resolution and returns a payload,
 * touching no database and no network. That makes the whole decision table
 * testable, which matters because this is where the product's manners live: the
 * difference between an assistant that feels considered and one that feels
 * like a command line is almost entirely in these strings.
 *
 * Two rules it enforces structurally:
 *
 *  1. **A destructive verb always produces a confirmation, never an action.**
 *     There is no branch here that returns "done" for a delete (ADR 0004).
 *  2. **An unresolved target always produces a question**, never a silent
 *     no-op. Saying nothing is the one response users read as "it's broken".
 */

export interface PlanContext {
  intent: CommandIntent;
  resolution: Resolution;
  /** The subject of the resolved email, when we have one, for confirmations. */
  subject?: string;
  /** True when the parser thought the message was dictated reply text. */
  looksLikeReplyBody: boolean;
  /** The raw message, used when it is being treated as a reply body. */
  rawText: string;
}

/**
 * The concrete thing to do, when the plan involves doing something.
 *
 * Separate from `payload` because the payload is what we *say* and this is what
 * we *do* — and the doing has to happen first. A message that reports an archive
 * we then failed to perform is the one outcome worse than an error.
 */
export type PlannedEffect =
  | { kind: 'mutate'; operation: MailOperation }
  | { kind: 'reply'; body: string }
  /**
   * Ask the assistant something about this email.
   *
   * Unlike the other two, the *answer* is the message — so the payload the
   * planner returns alongside it is a placeholder the processor discards. That
   * is why these carry `followUp: 'queue_query'` rather than `'queue_action'`:
   * the two are handled differently downstream, and one name for both would
   * mean a summary that reads "Archived."
   */
  | { kind: 'summarize' }
  | { kind: 'translate'; language: string };

export interface PlannedResponse {
  payload: WhatsAppOutboundPayload;
  /** What the worker should do after sending, if anything. */
  followUp:
    | 'none'
    | 'await_confirmation'
    | 'await_reply_text'
    | 'queue_send'
    | 'queue_action'
    | 'queue_query';
  /**
   * Present exactly when `followUp` is `queue_send`, `queue_action` or
   * `queue_query`. The caller must carry it out before sending `payload` — and
   * for `queue_query` it replaces `payload` with what came back.
   */
  effect?: PlannedEffect;
  /** The email this response concerns, for the delivery record. */
  emailMessageId?: string;
}

@Injectable()
export class ResponsePlanner {
  plan(context: PlanContext): PlannedResponse {
    const { intent, resolution } = context;

    // Commands that need no target at all are answered first, so a user with an
    // empty mailbox can still ask for help or cancel something.
    const untargeted = this.planUntargeted(intent);
    if (untargeted) return untargeted;

    // Everything below concerns a specific email. If we could not identify one,
    // we ask — and we ask in the shape that gives the user a one-tap answer.
    if (resolution.outcome === 'ambiguous') {
      return {
        payload: buildDisambiguation(resolution.options.map(toOption)),
        followUp: 'await_confirmation',
      };
    }

    if (resolution.outcome === 'none') {
      return {
        payload: buildText(this.explainNothingFound(intent, resolution.basis)),
        followUp: 'none',
      };
    }

    return this.planForEmail(context, resolution.emailMessageId);
  }

  /** Commands that stand alone, independent of any email. */
  private planUntargeted(intent: CommandIntent): PlannedResponse | null {
    switch (intent.intent) {
      case 'help':
        return { payload: buildText(HELP_TEXT), followUp: 'none' };

      case 'cancel':
        return {
          payload: buildText('Cancelled. Nothing was sent.'),
          followUp: 'none',
        };

      case 'question':
        return {
          payload: buildText(
            "I can't answer questions about your mailbox yet. " +
              'Try *search <words>*, *unread*, *urgent* or *deadlines*.',
          ),
          followUp: 'none',
        };

      // `search` and every `list_*` are deliberately absent. They are reads over
      // the whole mailbox rather than actions on one email, so they are answered
      // by MailboxQueryService before the processor ever calls the planner —
      // this class stays pure and target-oriented, and never grows a database
      // dependency to serve five intents.
      //
      // If one reaches here it means that interception was removed, so it falls
      // through to the default rather than being silently mishandled.

      default:
        return null;
    }
  }

  private planForEmail(context: PlanContext, emailMessageId: string): PlannedResponse {
    const { intent, subject } = context;

    switch (intent.intent) {
      // --- destructive: confirmation only, never the action ----------------
      case 'delete':
        return {
          payload: buildDeleteConfirmation(emailMessageId, subject ?? 'this email'),
          followUp: 'await_confirmation',
          emailMessageId,
        };

      case 'forward':
        return {
          payload: {
            kind: 'buttons',
            header: 'Forward this email?',
            body: clamp(`*${subject ?? 'This email'}*\n\nForward to ${intent.recipient}?`, 1024),
            footer: 'It will be sent from your own address',
            buttons: [
              {
                id: encodeActionPayload({ action: 'confirm_send', targetId: emailMessageId }),
                title: '➡️ Forward',
              },
              {
                id: encodeActionPayload({ action: 'cancel', targetId: emailMessageId }),
                title: 'Cancel',
              },
            ],
          },
          followUp: 'await_confirmation',
          emailMessageId,
        };

      // --- replying --------------------------------------------------------
      case 'reply':
        if (intent.body) {
          return {
            payload: buildText(`Sending your reply to *${subject ?? 'this email'}*…`),
            followUp: 'queue_send',
            effect: { kind: 'reply', body: intent.body },
            emailMessageId,
          };
        }
        return {
          payload: buildText(
            `What would you like to say to *${subject ?? 'this email'}*? Just type it here.`,
          ),
          followUp: 'await_reply_text',
          emailMessageId,
        };

      case 'reply_affirmative':
      case 'reply_negative':
        return {
          payload: buildText(`Replying to *${subject ?? 'this email'}*…`),
          followUp: 'queue_send',
          effect: {
            kind: 'reply',
            body: intent.intent === 'reply_affirmative' ? YES_BODY : NO_BODY,
          },
          emailMessageId,
        };

      // --- reversible actions: just do them ---------------------------------
      case 'archive':
        return {
          payload: buildText(`Archived *${subject ?? 'that email'}*.`),
          followUp: 'queue_action',
          effect: { kind: 'mutate', operation: { kind: 'archive' } },
          emailMessageId,
        };

      case 'mark_read':
        return {
          payload: buildText(intent.read ? 'Marked as read.' : 'Marked as unread.'),
          followUp: 'queue_action',
          effect: { kind: 'mutate', operation: { kind: 'markRead', read: intent.read } },
          emailMessageId,
        };

      case 'mark_important':
        return {
          payload: buildText(intent.important ? 'Starred.' : 'Unstarred.'),
          followUp: 'queue_action',
          effect: { kind: 'mutate', operation: { kind: 'star', starred: intent.important } },
          emailMessageId,
        };

      // --- asking the assistant about this email ---------------------------
      // Reads, both of them. Nothing here can send, move or delete anything, so
      // there is no confirmation to ask for — the answer is the response.
      case 'summarize':
        return {
          payload: buildText('Reading it…'),
          followUp: 'queue_query',
          effect: { kind: 'summarize' },
          emailMessageId,
        };

      case 'translate':
        return {
          payload: buildText('Translating…'),
          followUp: 'queue_query',
          effect: { kind: 'translate', language: intent.language },
          emailMessageId,
        };

      case 'read_aloud':
      case 'draft':
        // Still unbuilt. Naming the specific missing capability is more useful
        // than a generic apology.
        return {
          payload: buildText(`I can't ${describeAiVerb(intent)} yet — that part isn't finished.`),
          followUp: 'none',
          emailMessageId,
        };

      case 'send':
        return {
          payload: buildText("There's no draft waiting to send."),
          followUp: 'none',
        };

      case 'undo':
        return {
          payload: buildText("There's nothing to undo right now."),
          followUp: 'none',
        };

      // --- prose with a thread in context is reply text ----------------------
      case 'unknown':
        if (context.looksLikeReplyBody) {
          return {
            payload: buildText(`Sending that as your reply to *${subject ?? 'this email'}*…`),
            followUp: 'queue_send',
            effect: { kind: 'reply', body: context.rawText },
            emailMessageId,
          };
        }
        return {
          payload: buildText(
            "I didn't catch that. Try *reply*, *archive*, *delete*, or just type your reply.",
          ),
          followUp: 'none',
          emailMessageId,
        };

      default:
        return {
          payload: buildText("I didn't catch that. Send *help* to see what I understand."),
          followUp: 'none',
        };
    }
  }

  /**
   * Why nothing was found, in the user's terms.
   *
   * The resolver's `basis` is written for logs; this turns it into something
   * worth reading on a phone.
   */
  private explainNothingFound(intent: CommandIntent, basis: string): string {
    if (basis.startsWith('no recent email from')) {
      const name = basis.slice('no recent email from '.length);
      return `I couldn't find a recent email from ${name}.`;
    }
    if (intent.intent === 'reply' || intent.intent === 'reply_affirmative') {
      return "I'm not sure which email you're replying to. Reply directly to one of my messages and I'll pick it up.";
    }
    return "There's no recent email for me to act on.";
  }
}

function toOption(candidate: ResolutionCandidate) {
  return {
    emailMessageId: candidate.emailMessageId,
    ...(candidate.fromName ? { fromName: candidate.fromName } : {}),
    fromAddress: candidate.fromAddress,
    subject: candidate.subject,
  };
}

function describeAiVerb(intent: CommandIntent): string {
  return intent.intent === 'read_aloud' ? 'read emails aloud' : 'draft replies for you';
}

const HELP_TEXT = [
  "Here's what I understand:",
  '',
  '*Replying*',
  '• Reply directly to any email I send you',
  '• _reply with I will send it Friday_',
  '• _yes_ / _no_ for a quick answer',
  '',
  '*Managing*',
  '• _archive_ — file it away',
  '• _delete_ — asks you to confirm first',
  '• _mark unread_ · _important_',
  '',
  '*Finding and reading*',
  '• _search invoices from Tom_',
  '• _unread_ · _today_ · _urgent_ · _deadlines_',
  '• _summarise_ · _translate to swahili_',
  '',
  'Your replies go out from your own email address, threaded normally. ' +
    'Nobody can tell you answered from WhatsApp.',
].join('\n');
