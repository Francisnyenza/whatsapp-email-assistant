import { Injectable } from '@nestjs/common';
import {
  AppError,
  encodeActionPayload,
  type CommandIntent,
  type EmailAddress,
  type MailOperation,
  type WhatsAppOutboundPayload,
} from '@wea/shared';
import { parseRecipientList } from '@wea/mail';
import {
  buildDisambiguation,
  buildDeleteConfirmation,
  buildSendConfirmation,
  buildText,
  clamp,
} from '@wea/whatsapp';
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
  | { kind: 'reply'; body: string; replyAll?: boolean }
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
  | { kind: 'translate'; language: string }
  /**
   * Read it out. The answer is audio rather than text, but it is the same shape
   * of effect — the placeholder is discarded and the result is the message.
   */
  | { kind: 'speak' }
  /** Send this email's files into the chat, one queued job each. */
  | { kind: 'attachments' }
  /**
   * File it under a name. Names rather than ids, because the planner is pure and
   * resolving one against the mailbox is a network call — the processor does it,
   * and it is what stops a Gmail mailbox being handed a name it ignores.
   */
  | { kind: 'label'; add?: string; remove?: string }
  /**
   * Put it down until later. The time is raw text for the same reason a label
   * name is: resolving it needs the user's timezone, which this class does not
   * have and should not acquire.
   */
  | { kind: 'snooze'; until: string }
  /**
   * Take back the last thing. Names no email — what it acts on is whatever was
   * recorded when that action succeeded, which is the only thing that makes an
   * undo specific rather than a guess.
   */
  | { kind: 'undo' }
  /**
   * Forget the files the user sent *into* the chat. Like a compose, it names no
   * email — what it acts on is the set of files waiting for the next one.
   */
  | { kind: 'discard_files' }
  /**
   * Send a brand-new email. The only effect here with no email behind it — a
   * compose has no parent, so nothing in the resolution ladder applies and the
   * recipient comes from what the user typed rather than from a stored message.
   */
  | { kind: 'compose'; to: string; cc?: string; bcc?: string; subject: string; body: string }
  /**
   * Compose a reply and *ask*. The only effect here that produces words which
   * could leave the building — so unlike the two above, its result is not sent
   * to the correspondent, it is shown to the user with a confirmation button
   * (ADR 0004).
   */
  | { kind: 'draft'; instruction?: string };

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

      case 'compose':
        return planCompose(intent);

      // Untargeted because the email is whatever the last action named, which
      // this class has no way to know — the processor reads it from the record.
      // The answer is what was actually put back, so the payload here is a
      // placeholder: "Undone." before checking would be the "Archived." failure
      // in its purest form.
      case 'undo':
        return {
          payload: buildText('Taking that back…'),
          followUp: 'queue_query',
          effect: { kind: 'undo' },
        };

      // Untargeted for the same reason a compose is: the files the user is
      // holding belong to the conversation, not to any one email. The count
      // comes back from the effect, so the payload here is a placeholder the
      // processor replaces — saying "dropped 3 files" before checking would be
      // the "Archived." failure again.
      case 'discard_files':
        return {
          payload: buildText('Dropping them…'),
          followUp: 'queue_query',
          effect: { kind: 'discard_files' },
        };

      // `question`, `search` and every `list_*` are deliberately absent. They are
      // reads over the whole mailbox rather than actions on one email, so they
      // are answered by MailboxQueryService before the processor ever calls the
      // planner — this class stays pure and target-oriented, and never grows a
      // database dependency to serve six intents.
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
            payload: buildText(
              intent.replyAll
                ? `Replying to everyone on *${subject ?? 'this email'}*…`
                : `Sending your reply to *${subject ?? 'this email'}*…`,
            ),
            followUp: 'queue_send',
            effect: {
              kind: 'reply',
              body: intent.body,
              ...(intent.replyAll ? { replyAll: true } : {}),
            },
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

      case 'mark_spam':
        return {
          payload: buildText(
            intent.isSpam
              ? 'Moved to spam. Future mail from them may go there too.'
              : "Moved back to your inbox, and marked as not spam so it doesn't happen again.",
          ),
          followUp: 'queue_action',
          effect: { kind: 'mutate', operation: { kind: 'spam', isSpam: intent.isSpam } },
          emailMessageId,
        };

      // The answer names the labels as the *mailbox* spells them, which the
      // planner cannot know, so the payload here is a placeholder the processor
      // replaces. Saying "Filed under receipts" when the mailbox filed it under
      // "Receipts" is a small lie that makes the next command fail.
      case 'label':
        return {
          payload: buildText('Filing…'),
          followUp: 'queue_query',
          effect: {
            kind: 'label',
            ...(intent.add ? { add: intent.add } : {}),
            ...(intent.remove ? { remove: intent.remove } : {}),
          },
          emailMessageId,
        };

      // The answer is the resolved time, in the user's own terms, which is the
      // only version they can catch a mistake in — so the payload here is a
      // placeholder the processor replaces. "Snoozed until Monday" when the
      // system understood next Monday is a promise that will be broken quietly.
      case 'snooze':
        return {
          payload: buildText('Putting it down…'),
          followUp: 'queue_query',
          effect: { kind: 'snooze', until: intent.until },
          emailMessageId,
        };

      // --- asking the assistant about this email ---------------------------
      // Reads, both of them. Nothing here can send, move or delete anything, so
      // there is no confirmation to ask for — the answer is the response.
      case 'get_attachment':
        return {
          // A placeholder the processor keeps rather than discards: the files
          // arrive as separate messages afterwards, so this one is the only
          // acknowledgement the user gets that anything is happening.
          payload: buildText('Fetching the files…'),
          followUp: 'queue_action',
          effect: { kind: 'attachments' },
          emailMessageId,
        };

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

      case 'draft':
        // Composes, then asks. There is no branch here that sends a drafted
        // reply, for the same reason there is none that deletes: the model
        // wrote it, so the user authorizes it (ADR 0004).
        return {
          payload: buildText('Writing something…'),
          followUp: 'queue_query',
          effect: {
            kind: 'draft',
            ...(intent.instruction ? { instruction: intent.instruction } : {}),
          },
          emailMessageId,
        };

      case 'read_aloud':
        return {
          payload: buildText('Recording it…'),
          followUp: 'queue_query',
          effect: { kind: 'speak' },
          emailMessageId,
        };

      case 'send':
        return {
          payload: buildText("There's no draft waiting to send."),
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

/**
 * A brand-new email.
 *
 * Untargeted by nature: there is no message being answered, so the resolution
 * ladder has nothing to resolve and every field comes from what the user typed.
 * That is what makes this the one planned effect that validates its own input —
 * elsewhere the recipient is derived from a stored message and is trustworthy
 * by construction.
 *
 * The recipient is checked *here*, before a confirmation is offered, so a
 * typo produces "that is not an address I can send to" rather than a
 * confirmation button that fails after the user has approved it. Approving
 * something that then does not happen is the worst of both: they believe it
 * went, and it did not.
 */
function planCompose(intent: {
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
}): PlannedResponse {
  let recipients: EmailAddress[];
  let copies: EmailAddress[] = [];
  let blind: EmailAddress[] = [];

  try {
    recipients = parseRecipientList(intent.to);
    // Validated to the same standard as `to`, and refused just as hard. A Cc is
    // no less irreversible than a To — the message arrives either way. A Bcc is
    // the least recoverable of the three: nobody on the message can see that it
    // went to the wrong person, so nobody can tell the sender.
    if (intent.cc) copies = parseRecipientList(intent.cc);
    if (intent.bcc) blind = parseRecipientList(intent.bcc);
  } catch (err) {
    // `parseRecipientList` refuses with a message written for a person; showing
    // it beats replacing it with something vaguer.
    return {
      payload: buildText(AppError.from(err).publicMessage ?? 'I could not read that address.'),
      followUp: 'none',
    };
  }

  const body = intent.body?.trim();

  if (!body) {
    // Asked for rather than invented. A model could draft one, and that is a
    // different verb the user did not use — putting words in their mouth and
    // sending them under their name are one step apart here.
    return {
      payload: buildText(
        `I have the address. What should the email say?\n\n` +
          `Try: _email ${recipients[0]!.address} about ${intent.subject ?? 'the invoice'} saying …_`,
      ),
      followUp: 'none',
    };
  }

  const subject = intent.subject?.trim() || '(no subject)';
  const to = recipients.map((r) => r.address).join(', ');
  const cc = copies.map((r) => r.address).join(', ');
  const bcc = blind.map((r) => r.address).join(', ');

  return {
    payload: buildSendConfirmation(
      COMPOSE_TARGET,
      // Everyone who will receive it, shown before it is sent. A Cc the user
      // cannot see on the confirmation is a Cc they did not agree to — and the
      // Bcc is shown for the same reason and no other. Hiding it here because
      // "the point of a Bcc is that it is hidden" would hide it from the one
      // person it is not hidden from, who is the only one who can catch a
      // mistake in it.
      [to, ...(cc ? [`*Cc:* ${cc}`] : []), ...(bcc ? [`*Bcc:* ${bcc}`] : [])].join('\n'),
      `*Subject:* ${subject}\n\n${body}`,
    ),
    followUp: 'await_confirmation',
    effect: {
      kind: 'compose',
      to,
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      subject,
      body,
    },
  };
}

/**
 * The id a compose confirmation is bound to.
 *
 * Every other confirmation names the email it concerns; a compose has none, and
 * the alternative — minting an id here — would put a value on the button that
 * the server did not choose. A fixed sentinel keeps the whole payload
 * server-minted: the tap says only "the compose you are holding for me", and
 * *which* compose is read from the pending action written server-side when the
 * user asked. A crafted tap can therefore only re-authorise the one message
 * they already read.
 */
export const COMPOSE_TARGET = 'compose';

const HELP_TEXT = [
  "Here's what I understand:",
  '',
  '*Replying*',
  '• Reply directly to any email I send you',
  '• _reply with I will send it Friday_',
  '• _yes_ / _no_ for a quick answer',
  '• _reply all saying I agree_ — copies everyone on the thread',
  '',
  '*Managing*',
  '• _archive_ — file it away',
  '• _delete_ — asks you to confirm first',
  '• _mark unread_ · _important_',
  '• _this is spam_ · _not spam_',
  '• _label this as Receipts_ · _remove the Receipts label_',
  '• _snooze until tomorrow_ · _snooze for 2 hours_ — I bring it back then',
  '• _undo_ — takes back the last thing, for ten minutes afterwards',
  '• _what labels do I have_',
  '',
  '*Finding and reading*',
  '• _search invoices from Tom_',
  '• _unread_ · _today_ · _urgent_ · _deadlines_',
  '• _summarise_ · _translate to swahili_',
  '• _read it aloud_ — comes back as a voice note',
  '• _send me the attachment_ — the files, into this chat',
  '',
  '*Asking*',
  '• _did anyone reply about the invoice?_',
  '• I answer from your own mail, and show you which emails I used',
  '',
  '*Sending something new*',
  '• _email alice@acme.com about Q3 saying the numbers are attached_',
  '• _email alice@acme.com saying running ten minutes late_',
  '• _email alice@acme.com cc bob@acme.com saying …_',
  '• _email alice@acme.com bcc bob@acme.com saying …_ — I show you the Bcc, nobody else sees it',
  '',
  '*Attaching a file*',
  '• Send me a photo or a document — I hold it for your next email',
  '• _drop the files_ — forget what I am holding',
  '',
  '*Writing*',
  '• _draft a polite no_ — I write it, you approve it',
  '',
  'Your replies go out from your own email address, threaded normally. ' +
    'Nobody can tell you answered from WhatsApp.',
].join('\n');
