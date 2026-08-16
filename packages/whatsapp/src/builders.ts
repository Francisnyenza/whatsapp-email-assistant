import {
  WHATSAPP_LIMITS,
  encodeActionPayload,
  type WhatsAppButtonsPayload,
  type WhatsAppListPayload,
  type WhatsAppTextPayload,
  type WhatsAppOutboundPayload,
  type EmailPriority,
  type EmailCategory,
} from '@wea/shared';

/**
 * Turning an email into a WhatsApp message.
 *
 * The constraints are tight and unforgiving: 1024 characters for an interactive
 * body, 20 for a button title, 3 buttons maximum. Meta truncates silently past
 * these, which produces a mangled card rather than an error — so everything here
 * clamps deliberately, and clamps at a character boundary rather than mid-word.
 *
 * The card has to answer one question in the two seconds someone glances at
 * their lock screen: *does this need me right now?* Sender, subject and the AI
 * summary come first; everything else is secondary.
 */

export interface EmailNotificationInput {
  emailMessageId: string;
  fromName?: string;
  fromAddress: string;
  subject: string;
  receivedAt: Date;
  priority: EmailPriority;
  category: EmailCategory | string;
  summary?: string;
  attachmentCount: number;
  attachmentNames: string[];
  /** Short AI-suggested replies, offered as buttons. */
  suggestedReplies: string[];
  /** True when the body contained text aimed at an automated assistant. */
  flaggedForInstructionText?: boolean;
  /** IANA timezone for rendering the received time. */
  timezone: string;
  locale: string;
}

const PRIORITY_MARK: Record<EmailPriority, string> = {
  urgent: '🔴 URGENT',
  high: '🟠 High',
  normal: '',
  low: '',
};

const CATEGORY_ICON: Record<string, string> = {
  invoice: '🧾',
  finance: '💰',
  travel: '✈️',
  work: '💼',
  personal: '👤',
  newsletter: '📰',
  promotion: '🏷️',
  social: '💬',
  support: '🛟',
  recruitment: '🧑‍💼',
  legal: '⚖️',
  notification: '🔔',
  shopping: '🛒',
  spam: '⚠️',
};

/**
 * Truncates at a word boundary and appends an ellipsis, never exceeding `max`.
 *
 * Meta counts characters, not bytes, and an emoji counts as its UTF-16 length —
 * so `Array.from` is used to avoid splitting a surrogate pair, which renders as
 * a replacement character.
 */
export function clamp(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max <= 1) return chars.slice(0, max).join('');

  const truncated = chars.slice(0, max - 1).join('');
  const lastSpace = truncated.lastIndexOf(' ');
  // Only break on a word boundary if it does not cost most of the text.
  const body = lastSpace > max * 0.6 ? truncated.slice(0, lastSpace) : truncated;
  return `${body.trimEnd()}…`;
}

function formatTime(date: Date, timezone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/**
 * The notification card for one inbound email.
 *
 * Buttons are minted server-side and carry our own record id, which is what
 * makes a tap an authorization rather than a hint (ADR 0004).
 */
export function buildEmailNotification(input: EmailNotificationInput): WhatsAppButtonsPayload {
  const lines: string[] = [];

  const priority = PRIORITY_MARK[input.priority];
  const icon = CATEGORY_ICON[input.category] ?? '📧';

  const header = priority ? `${priority} · ${icon} New email` : `${icon} New email`;

  const sender = input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress;
  lines.push(`*From:* ${clamp(sender, 120)}`);
  lines.push(`*Subject:* ${clamp(input.subject || '(no subject)', 150)}`);
  lines.push(`*Time:* ${formatTime(input.receivedAt, input.timezone, input.locale)}`);

  if (input.summary) {
    lines.push('');
    lines.push(clamp(input.summary, 400));
  }

  if (input.attachmentCount > 0) {
    const names = input.attachmentNames.slice(0, 3).map((n) => clamp(n, 30));
    const more = input.attachmentCount - names.length;
    lines.push('');
    lines.push(
      `📎 ${input.attachmentCount} attachment${input.attachmentCount > 1 ? 's' : ''}: ` +
        names.join(', ') +
        (more > 0 ? ` +${more} more` : ''),
    );
  }

  if (input.flaggedForInstructionText) {
    // Surfaced, never acted on (ADR 0004).
    lines.push('');
    lines.push('⚠️ This email contains text that tries to give instructions to an assistant.');
  }

  return {
    kind: 'buttons',
    header: clamp(header, WHATSAPP_LIMITS.headerText),
    body: clamp(lines.join('\n'), WHATSAPP_LIMITS.interactiveBody),
    footer: 'Reply here to answer by email',
    buttons: buildActionButtons(input),
  };
}

/**
 * At most three buttons, so they are chosen by usefulness: the most likely reply
 * first, then reply, then archive. "Delete" is deliberately absent — it is
 * destructive and reachable by typing, where a confirmation step applies.
 */
function buildActionButtons(input: EmailNotificationInput) {
  const buttons = [];
  const suggestion = input.suggestedReplies[0];

  if (suggestion) {
    buttons.push({
      id: encodeActionPayload({ action: 'reply_yes', targetId: input.emailMessageId }),
      title: clamp(suggestion, WHATSAPP_LIMITS.buttonTitle),
    });
  }

  buttons.push({
    id: encodeActionPayload({ action: 'reply', targetId: input.emailMessageId }),
    title: '✍️ Reply',
  });

  if (buttons.length < WHATSAPP_LIMITS.buttonCount) {
    buttons.push({
      id: encodeActionPayload({ action: 'archive', targetId: input.emailMessageId }),
      title: '📥 Archive',
    });
  }

  return buttons.slice(0, WHATSAPP_LIMITS.buttonCount);
}

export interface DigestItem {
  emailMessageId: string;
  fromName?: string;
  fromAddress: string;
  subject: string;
  priority: EmailPriority;
  summary?: string;
}

/**
 * A digest of everything that arrived while we could not, or chose not to,
 * notify. Rendered as a selectable list so a tap opens one message.
 */
export function buildDigest(items: DigestItem[], title = 'Your emails'): WhatsAppListPayload {
  const rows = items.slice(0, WHATSAPP_LIMITS.listRowCount).map((item) => ({
    id: encodeActionPayload({ action: 'open_thread', targetId: item.emailMessageId }),
    title: clamp(item.fromName ?? item.fromAddress, WHATSAPP_LIMITS.listRowTitle),
    description: clamp(item.subject || '(no subject)', WHATSAPP_LIMITS.listRowDescription),
  }));

  const urgent = items.filter((i) => i.priority === 'urgent' || i.priority === 'high').length;
  const overflow = items.length - rows.length;

  const bodyLines = [`You have *${items.length}* new email${items.length === 1 ? '' : 's'}.`];
  if (urgent > 0) bodyLines.push(`${urgent} need${urgent === 1 ? 's' : ''} attention.`);
  if (overflow > 0) bodyLines.push(`Showing the first ${rows.length}; ${overflow} more waiting.`);

  return {
    kind: 'list',
    header: clamp(title, WHATSAPP_LIMITS.headerText),
    body: clamp(bodyLines.join('\n'), WHATSAPP_LIMITS.interactiveBody),
    buttonText: clamp('View emails', WHATSAPP_LIMITS.listButtonText),
    sections: [{ title: 'Recent', rows }],
  };
}

export interface SearchResultItem {
  emailMessageId: string;
  fromName?: string;
  fromAddress: string;
  subject: string;
  isUnread: boolean;
}

/**
 * Search results.
 *
 * A list rather than free text, because the useful next step is almost always
 * "that one" — and a row id is a server-minted target, so the tap that follows
 * is an authorization rather than a guess at what the user meant (ADR 0004).
 *
 * The row title is the sender and the description is the subject, matching the
 * digest exactly. Search results and the morning digest are the same gesture
 * from the user's side, and two layouts for one gesture is a small cruelty.
 */
export function buildSearchResults(
  query: string,
  items: SearchResultItem[],
): WhatsAppOutboundPayload {
  if (items.length === 0) {
    return buildText(
      `I couldn't find anything matching “${clamp(query, 100)}”. ` +
        'Try a sender’s name, or a word from the subject.',
    );
  }

  const rows = items.slice(0, WHATSAPP_LIMITS.listRowCount).map((item) => ({
    id: encodeActionPayload({ action: 'open_thread', targetId: item.emailMessageId }),
    title: clamp(
      `${item.isUnread ? '• ' : ''}${item.fromName ?? item.fromAddress}`,
      WHATSAPP_LIMITS.listRowTitle,
    ),
    description: clamp(item.subject || '(no subject)', WHATSAPP_LIMITS.listRowDescription),
  }));

  const overflow = items.length - rows.length;

  return {
    kind: 'list',
    header: clamp(`Results for “${query}”`, WHATSAPP_LIMITS.headerText),
    body: clamp(
      [
        `Found *${items.length}* email${items.length === 1 ? '' : 's'}.`,
        ...(overflow > 0 ? [`Showing the closest ${rows.length}.`] : []),
        '',
        'Pick one to reply, archive or delete it.',
      ].join('\n'),
      WHATSAPP_LIMITS.interactiveBody,
    ),
    buttonText: clamp('View results', WHATSAPP_LIMITS.listButtonText),
    sections: [{ title: 'Matches', rows }],
  };
}

/** Confirmation before a reply is actually sent. */
export function buildSendConfirmation(
  draftId: string,
  recipient: string,
  bodyPreview: string,
): WhatsAppButtonsPayload {
  return {
    kind: 'buttons',
    header: 'Ready to send',
    body: clamp(
      `*To:* ${clamp(recipient, 100)}\n\n${bodyPreview}`,
      WHATSAPP_LIMITS.interactiveBody,
    ),
    footer: 'This will be sent from your own email address',
    buttons: [
      { id: encodeActionPayload({ action: 'confirm_send', targetId: draftId }), title: '✅ Send' },
      { id: encodeActionPayload({ action: 'reply', targetId: draftId }), title: '✏️ Edit' },
      { id: encodeActionPayload({ action: 'cancel', targetId: draftId }), title: '✖️ Cancel' },
    ],
  };
}

/**
 * Confirmation before sending words a model wrote.
 *
 * The whole draft goes in the body, never a preview: the confirmation is only
 * meaningful if the user has read what they are approving, and "…" in the middle
 * of a sentence is how someone sends a paragraph they never saw. The composer
 * bounds the draft to well under the interactive-body limit for exactly this
 * reason.
 *
 * The text itself is *not* on the buttons. It is stored server-side against the
 * conversation, and the button carries only our own message id — so a replayed
 * or altered tap can re-authorize what the user read and nothing else
 * (ADR 0004).
 */
export function buildDraftConfirmation(
  emailMessageId: string,
  body: string,
): WhatsAppButtonsPayload {
  return {
    kind: 'buttons',
    header: 'Send this reply?',
    body: clamp(body, WHATSAPP_LIMITS.interactiveBody),
    footer: 'It goes from your own address, in your own thread',
    buttons: [
      {
        id: encodeActionPayload({ action: 'confirm_send', targetId: emailMessageId }),
        title: '✅ Send',
      },
      {
        // Falls into the ordinary "type your reply" flow, which replaces the
        // draft with the user's own words rather than trying to edit it in a
        // chat window.
        id: encodeActionPayload({ action: 'reply', targetId: emailMessageId }),
        title: '✏️ Write my own',
      },
      {
        id: encodeActionPayload({ action: 'cancel', targetId: emailMessageId }),
        title: '✖️ Cancel',
      },
    ],
  };
}

/**
 * Confirmation before a destructive action. The button carries the resolved
 * target id, so the tap authorizes exactly one action on exactly one message
 * (ADR 0004).
 */
export function buildDeleteConfirmation(
  emailMessageId: string,
  subject: string,
): WhatsAppButtonsPayload {
  return {
    kind: 'buttons',
    header: 'Delete this email?',
    body: clamp(`*${clamp(subject, 150)}*\n\nThis moves it to trash in your mailbox.`, 1024),
    buttons: [
      {
        id: encodeActionPayload({ action: 'confirm_delete', targetId: emailMessageId }),
        title: '🗑 Delete',
      },
      { id: encodeActionPayload({ action: 'cancel', targetId: emailMessageId }), title: 'Keep it' },
    ],
  };
}

/**
 * Disambiguation, when the thread-resolution ladder ran out of confidence
 * (ADR 0003, rank 5). We ask rather than guess.
 */
export function buildDisambiguation(
  options: Array<{
    emailMessageId: string;
    fromName?: string;
    fromAddress: string;
    subject: string;
  }>,
): WhatsAppListPayload {
  return {
    kind: 'list',
    header: 'Which email?',
    body: "I'm not sure which email you meant. Pick one:",
    buttonText: 'Choose',
    sections: [
      {
        title: 'Recent emails',
        rows: options.slice(0, WHATSAPP_LIMITS.listRowCount).map((option) => ({
          id: encodeActionPayload({ action: 'reply', targetId: option.emailMessageId }),
          title: clamp(option.fromName ?? option.fromAddress, WHATSAPP_LIMITS.listRowTitle),
          description: clamp(option.subject, WHATSAPP_LIMITS.listRowDescription),
        })),
      },
    ],
  };
}

export function buildText(body: string): WhatsAppTextPayload {
  return { kind: 'text', body: clamp(body, WHATSAPP_LIMITS.textBody) };
}

/**
 * An answer to a question, with the emails it came from.
 *
 * Not `buildDigest`: that one opens "You have N new emails", which is a
 * different sentence from "here is what I found out", and reusing it would tell
 * the user their answer was a delivery.
 *
 * The rows matter more than they look. An answer about someone's mail is a
 * claim, and a claim the user cannot check is worse than no answer — so every
 * email the answer drew on is offered as a tappable row, which is both the
 * citation and the way to go read the thing for themselves. The ids are
 * server-minted `open_thread` targets like every other row here (ADR 0004), so
 * naming a source cannot widen what the tap after it may touch.
 *
 * With nothing cited it falls back to text. A list with an empty section is
 * rejected by the API, and "I can't tell from these" is a complete answer that
 * genuinely has no sources.
 */
export function buildAnswer(answer: string, sources: SearchResultItem[]): WhatsAppOutboundPayload {
  const rows = sources.slice(0, WHATSAPP_LIMITS.listRowCount).map((item) => ({
    id: encodeActionPayload({ action: 'open_thread', targetId: item.emailMessageId }),
    title: clamp(item.fromName ?? item.fromAddress, WHATSAPP_LIMITS.listRowTitle),
    description: clamp(item.subject || '(no subject)', WHATSAPP_LIMITS.listRowDescription),
  }));

  if (rows.length === 0) return buildText(answer);

  return {
    kind: 'list',
    header: clamp('Answer', WHATSAPP_LIMITS.headerText),
    body: clamp(answer, WHATSAPP_LIMITS.interactiveBody),
    buttonText: clamp('Show sources', WHATSAPP_LIMITS.listButtonText),
    sections: [{ title: rows.length === 1 ? 'From this email' : 'From these emails', rows }],
  };
}

/**
 * Final safety net before a payload leaves for Meta.
 *
 * Every builder above already clamps, but payloads also come from command
 * handlers and AI-drafted text. Exceeding a limit is a 400 from Meta, which
 * surfaces to the user as silence — so this clamps rather than throws.
 */
export function enforceLimits(payload: WhatsAppOutboundPayload): WhatsAppOutboundPayload {
  switch (payload.kind) {
    case 'text':
      return { ...payload, body: clamp(payload.body, WHATSAPP_LIMITS.textBody) };

    case 'buttons':
      return {
        ...payload,
        body: clamp(payload.body, WHATSAPP_LIMITS.interactiveBody),
        ...(payload.header ? { header: clamp(payload.header, WHATSAPP_LIMITS.headerText) } : {}),
        ...(payload.footer ? { footer: clamp(payload.footer, WHATSAPP_LIMITS.footerText) } : {}),
        buttons: payload.buttons.slice(0, WHATSAPP_LIMITS.buttonCount).map((b) => ({
          ...b,
          title: clamp(b.title, WHATSAPP_LIMITS.buttonTitle),
        })),
      };

    case 'list':
      return {
        ...payload,
        body: clamp(payload.body, WHATSAPP_LIMITS.interactiveBody),
        ...(payload.header ? { header: clamp(payload.header, WHATSAPP_LIMITS.headerText) } : {}),
        ...(payload.footer ? { footer: clamp(payload.footer, WHATSAPP_LIMITS.footerText) } : {}),
        buttonText: clamp(payload.buttonText, WHATSAPP_LIMITS.listButtonText),
        sections: payload.sections.map((section) => ({
          ...section,
          rows: section.rows.slice(0, WHATSAPP_LIMITS.listRowCount).map((row) => ({
            ...row,
            title: clamp(row.title, WHATSAPP_LIMITS.listRowTitle),
            ...(row.description
              ? { description: clamp(row.description, WHATSAPP_LIMITS.listRowDescription) }
              : {}),
          })),
        })),
      };

    default:
      return payload;
  }
}
