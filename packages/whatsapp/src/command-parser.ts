import { resolveLanguage, type CommandIntent } from '@wea/shared';

/**
 * Deterministic command parsing.
 *
 * Intent is parsed from *the user's own WhatsApp message*, never from email
 * content — two code paths, two trust levels (ADR 0004).
 *
 * The fast path here handles the overwhelming majority of traffic. Only what it
 * cannot classify goes to the model, for three reasons:
 *
 *  1. **Cost.** An LLM call per message, at millions of messages a day, is the
 *     single largest line item we can avoid.
 *  2. **Latency.** Regex is microseconds; a model call is hundreds of
 *     milliseconds on the path a user is watching.
 *  3. **Predictability.** "delete" must mean delete every time. A classifier
 *     that is 98% accurate on destructive verbs is 2% catastrophic.
 *
 * A deliberate design point: this parser returns `unknown` rather than guessing.
 * The caller escalates to the model, and the model's answer is still validated
 * against a schema before it reaches an action.
 */

export interface ParseResult {
  intent: CommandIntent;
  /** How the intent was determined, for analytics and debugging. */
  source: 'deterministic';
  /**
   * True when the message is plain prose with no command in it — most likely
   * the body of a reply the user is dictating, not an instruction.
   */
  looksLikeReplyBody: boolean;
}

const AFFIRMATIVE = new Set([
  'yes',
  'yep',
  'yeah',
  'yup',
  'ok',
  'okay',
  'sure',
  'confirm',
  'confirmed',
  'agreed',
  'sawa',
  'ndio',
  'ndiyo', // Swahili
  'oui',
  'si',
  'sí',
  'ja',
  'da',
  'hai',
  'haan',
  'naam',
  'nam',
]);

const NEGATIVE = new Set([
  'no',
  'nope',
  'nah',
  'negative',
  'decline',
  'reject',
  'hapana',
  'la', // Swahili
  'non',
  'nein',
  'nyet',
  'iie',
]);

/** Single-word commands, matched only when the message is exactly that word. */
const EXACT_COMMANDS: Record<string, CommandIntent> = {
  send: { intent: 'send' },
  cancel: { intent: 'cancel' },
  stop: { intent: 'cancel' },
  undo: { intent: 'undo' },
  oops: { intent: 'undo' },
  revert: { intent: 'undo' },
  help: { intent: 'help' },
  menu: { intent: 'help' },
  archive: { intent: 'archive' },
  delete: { intent: 'delete' },
  summarize: { intent: 'summarize' },
  summarise: { intent: 'summarize' },
  summary: { intent: 'summarize' },
  unread: { intent: 'list_unread' },
  today: { intent: 'list_today' },
  urgent: { intent: 'list_urgent' },
  deadlines: { intent: 'list_deadlines' },
};

/**
 * Splits "cc bob@x.com bcc carol@x.com" into its two lists.
 *
 * Both come out as raw text, exactly as the recipient does, and are validated
 * downstream by `parseRecipientList`. Recognising the shape of a request and
 * deciding where mail may go are different jobs, and a second, laxer parse here
 * is how an address the validator would refuse gets accepted on the way past.
 *
 * The marker has to be a whole word followed by a space — `\b` alone would find
 * one inside `cc.dept@acme.com` and cut the address in half.
 */
function splitCopyList(segment: string): { cc?: string; bcc?: string } {
  const marker = /(?:^|\s)(bcc|blind\s+cop(?:y|ying)|cc|copy(?:ing)?)\s+/gi;

  const found: Array<{ kind: 'cc' | 'bcc'; from: number; at: number }> = [];
  for (const match of segment.matchAll(marker)) {
    found.push({
      // "blind copy" and "bcc" both start with b; "copying" and "cc" do not.
      kind: match[1]!.toLowerCase().startsWith('b') ? 'bcc' : 'cc',
      at: match.index!,
      from: match.index! + match[0].length,
    });
  }

  const lists: { cc?: string; bcc?: string } = {};
  for (const [index, entry] of found.entries()) {
    const value = segment
      .slice(entry.from, found[index + 1]?.at ?? segment.length)
      .trim()
      .replace(/[,;]+$/, '');
    if (!value) continue;

    // "cc a@x.com cc b@x.com" is one list, not the second replacing the first.
    lists[entry.kind] = lists[entry.kind] ? `${lists[entry.kind]}, ${value}` : value;
  }

  return lists;
}

/**
 * Ordered patterns. First match wins, so more specific expressions come first —
 * "reply with X" must be tried before the bare "reply".
 */
const PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => CommandIntent }> = [
  // Reply with an explicit body.
  // Reply-all, matched before plain reply so "reply all saying X" is not read
  // as a reply whose body begins "all saying X".
  {
    re: /^(?:reply|respond)\s+(?:to\s+)?(?:all|everyone|everybody)\s+(?:with|saying|that)\s+(.+)$/is,
    build: (m) => ({ intent: 'reply', body: m[1]!.trim(), replyAll: true }),
  },
  {
    re: /^(?:reply|respond)\s+(?:to\s+)?(?:all|everyone|everybody)$/i,
    build: () => ({ intent: 'reply', replyAll: true }),
  },

  {
    re: /^(?:reply|respond|answer)\s+(?:with|saying|that)\s+(.+)$/is,
    build: (m) => ({ intent: 'reply', body: m[1]!.trim() }),
  },
  // "reply to sarah ..." — target named, body optional.
  {
    re: /^(?:reply|respond)\s+to\s+([\w.\-+@' ]{1,60}?)(?:\s+(?:with|saying|that)\s+(.+))?$/is,
    build: (m) => ({
      intent: 'reply',
      target: m[1]!.trim(),
      ...(m[2] ? { body: m[2].trim() } : {}),
    }),
  },
  { re: /^(?:reply|respond|answer)$/i, build: () => ({ intent: 'reply' }) },

  {
    // "email alice@x.com cc bob@x.com bcc carol@x.com about Q3 saying …" — the
    // copy lists sit between the recipient and the subject, which is where
    // people put them. Both are captured as one segment and split afterwards,
    // rather than as a rule per combination: cc-then-bcc and bcc-then-cc and
    // either alone are four regexes that would drift apart.
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+?)\s+((?:bcc|cc|blind\s+cop(?:y|ying)|copy(?:ing)?)\s+[^]+?)\s+(?:about\s+(.{1,200}?)\s+)?(?:saying|that\s+says|:)\s+(.+)$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim().replace(/[,;]$/, ''),
      ...splitCopyList(m[2]!),
      ...(m[3] ? { subject: m[3].trim() } : {}),
      body: m[4]!.trim(),
    }),
  },

  // A brand-new email. Ordered before `draft`, because "write to alice@x.com"
  // is an origination and "write a reply" is not, and `draft`'s pattern would
  // otherwise swallow both.
  //
  // The recipient is captured as raw text and validated downstream by
  // `parseRecipientList`, which refuses rather than repairs. Recognising the
  // shape of a request and deciding where mail may go are different jobs, and
  // doing the second twice means one of the two is laxer.
  {
    // "email alice@x.com from work saying …" — which mailbox it goes out from.
    // Matched before the plain forms, which would otherwise read "from work
    // saying …" as the subject.
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+?)\s+from\s+(?:my\s+)?([\w.@' -]{1,60}?)\s+(?:about\s+(.{1,200}?)\s+)?(?:saying|that\s+says|:)\s+(.+)$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim().replace(/[,;]$/, ''),
      from: m[2]!.trim(),
      ...(m[3] ? { subject: m[3].trim() } : {}),
      body: m[4]!.trim(),
    }),
  },

  {
    // "email alice@x.com about Q3 saying the numbers are attached"
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+?)\s+about\s+(.{1,200}?)\s+(?:saying|that\s+says|with|:)\s+(.+)$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim().replace(/[,;]$/, ''),
      subject: m[2]!.trim(),
      body: m[3]!.trim(),
    }),
  },
  {
    // "email alice@x.com saying the numbers are attached" — no subject given.
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+?)\s+(?:saying|that\s+says|:)\s+(.+)$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim().replace(/[,;]$/, ''),
      body: m[2]!.trim(),
    }),
  },
  {
    // "email alice@x.com about the invoice" — subject only, no body yet.
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+?)\s+about\s+(.{1,200})$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim().replace(/[,;]$/, ''),
      subject: m[2]!.trim(),
    }),
  },
  // The same forms with a *name* instead of an address. Matched after every
  // address form, so anything containing an @ never reaches here, and the name
  // is resolved against the user's own contacts downstream — which refuses
  // rather than guessing, because a wrong match sends private mail to a
  // stranger.
  {
    // "email sarah about Q3 saying the numbers are attached"
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to)\s+(?:to\s+)?([a-z][\w.' -]{1,39}?)\s+about\s+(.{1,200}?)\s+(?:saying|that\s+says|:)\s+(.+)$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim(),
      subject: m[2]!.trim(),
      body: m[3]!.trim(),
    }),
  },
  {
    // "email sarah saying running ten minutes late"
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to)\s+(?:to\s+)?([a-z][\w.' -]{1,39}?)\s+(?:saying|that\s+says|:)\s+(.+)$/is,
    build: (m) => ({ intent: 'compose', to: m[1]!.trim(), body: m[2]!.trim() }),
  },

  {
    // "email alice@x.com" — recipient only.
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+)$/i,
    build: (m) => ({ intent: 'compose', to: m[1]!.trim().replace(/[,;]$/, '') }),
  },

  // The files on an email. Matched before compose, because "send me the
  // attachment" starts with a verb compose also claims.
  {
    re: /^(?:send|give|show)\s+(?:me\s+)?(?:the\s+|its\s+|it'?s\s+)?(?:attachments?|files?|documents?|pdfs?)$/i,
    build: () => ({ intent: 'get_attachment' }),
  },
  {
    re: /^(?:attachments?|files?)\??$/i,
    build: () => ({ intent: 'get_attachment' }),
  },

  // The other direction: files the user sent *in*, which wait for the next
  // email they send. Matched before `draft|compose|write`, which claims a bare
  // verb and would read "clear the files" as an instruction to draft something.
  {
    re: /^(?:drop|discard|forget|clear|remove|cancel)\s+(?:the\s+|my\s+|those\s+|these\s+|all\s+(?:the\s+)?)?(?:files?|attachments?|photos?|pictures?|images?|documents?|uploads?)$/i,
    build: () => ({ intent: 'discard_files' }),
  },

  // Drafting is explicitly not sending.
  {
    re: /^(?:draft|compose|write)\s+(?:a\s+)?(?:reply|response|answer)?\s*(?:that\s+)?(.*)$/is,
    build: (m) => ({
      intent: 'draft',
      ...(m[1]?.trim() ? { instruction: m[1].trim() } : {}),
    }),
  },

  {
    re: /^forward\s+(?:this\s+)?(?:to\s+)?([\w.+-]+@[\w.-]+\.\w+)$/i,
    build: (m) => ({ intent: 'forward', recipient: m[1]!.toLowerCase() }),
  },

  {
    re: /^translate(?:\s+(?:this|it))?\s+(?:in)?to\s+(.+)$/i,
    build: (m) => ({ intent: 'translate', language: resolveLanguage(m[1]!)?.code ?? m[1]!.trim() }),
  },

  { re: /^(?:archive|file)(?:\s+(?:this|it))?$/i, build: () => ({ intent: 'archive' }) },
  {
    re: /^(?:delete|trash|bin|remove)(?:\s+(?:this|it))?$/i,
    build: () => ({ intent: 'delete' }),
  },

  { re: /^mark\s+(?:as\s+)?unread$/i, build: () => ({ intent: 'mark_read', read: false }) },
  { re: /^mark\s+(?:as\s+)?read$/i, build: () => ({ intent: 'mark_read', read: true }) },
  {
    re: /^(?:mark\s+(?:as\s+)?)?(?:important|star|flag)$/i,
    build: () => ({ intent: 'mark_important', important: true }),
  },

  // Not spam first: "not spam" contains "spam", and the wrong order would file
  // a rescued message straight back into junk.
  {
    re: /^(?:(?:this|it|that)\s*(?:'s|\s+is)\s+)?(?:not|isn'?t)\s+(?:spam|junk)$/i,
    build: () => ({ intent: 'mark_spam', isSpam: false }),
  },
  {
    re: /^(?:mark\s+(?:as\s+)?|move\s+to\s+)?(?:not\s+)?(?:un-?(?:spam|junk))$/i,
    build: () => ({ intent: 'mark_spam', isSpam: false }),
  },
  {
    re: /^(?:(?:this|it|that)\s*(?:'s|\s+is)\s+)?(?:mark\s+(?:as\s+)?|move\s+to\s+|report\s+(?:as\s+)?)?(?:spam|junk)$/i,
    build: () => ({ intent: 'mark_spam', isSpam: true }),
  },

  // Filing under a name. `remove` is matched first for the same reason "not
  // spam" is: "remove the Receipts label" contains "the Receipts label", and the
  // wrong order would file a message the user asked to unfile.
  {
    re: /^(?:remove|take\s+off|un-?label|delete)\s+(?:the\s+)?(?:label\s+)?["'“]?(.{1,60}?)["'”]?(?:\s+label)?$/i,
    build: (m) => ({ intent: 'label', remove: m[1]!.trim() }),
  },
  {
    re: /^(?:label|tag|file|categorise|categorize)\s+(?:this|it)?\s*(?:as|under|with|in)\s+["'“]?(.{1,60}?)["'”]?(?:\s+label)?$/i,
    build: (m) => ({ intent: 'label', add: m[1]!.trim() }),
  },
  {
    re: /^(?:add\s+(?:the\s+)?)?(?:label|tag)\s+["'“]?(.{1,60}?)["'”]?(?:\s+label)?$/i,
    build: (m) => ({ intent: 'label', add: m[1]!.trim() }),
  },
  {
    re: /^(?:what|which)\s+(?:labels?|tags?|categories)\s*(?:do\s+i\s+have|are\s+there|exist)?\??$/i,
    build: () => ({ intent: 'list_labels' }),
  },
  {
    re: /^(?:what|which)\s+folders?\s*(?:do\s+i\s+have|are\s+there|exist)?\??$/i,
    build: () => ({ intent: 'list_folders' }),
  },
  {
    re: /^(?:my\s+|show\s+(?:me\s+)?(?:my\s+)?|list\s+(?:my\s+)?)folders?$/i,
    build: () => ({ intent: 'list_folders' }),
  },

  // Moving. Matched before the label rules, which claim "file this in X" —
  // the two verbs overlap in English and mean different things: a label leaves
  // the message in the inbox and a move takes it out.
  {
    re: /^(?:move|put|filing)\s+(?:this|it)?\s*(?:in|into|to|under)\s+(?:the\s+)?["'“]?(.{1,60}?)["'”]?(?:\s+folder)?$/i,
    build: (m) => ({ intent: 'move', to: m[1]!.trim() }),
  },
  {
    re: /^(?:move|put)\s+(?:this|it)\s+(?:in|into|to)\s+["'“]?(.{1,60}?)["'”]?$/i,
    build: (m) => ({ intent: 'move', to: m[1]!.trim() }),
  },
  {
    re: /^(?:what|which)\s+(?:mailboxes|accounts|addresses|inboxes)\s*(?:do\s+i\s+have|are\s+(?:there|connected))?\??$/i,
    build: () => ({ intent: 'list_mailboxes' }),
  },
  {
    re: /^(?:my\s+|show\s+(?:me\s+)?(?:my\s+)?|list\s+(?:my\s+)?)(?:mailboxes|accounts|addresses|inboxes)$/i,
    build: () => ({ intent: 'list_mailboxes' }),
  },
  {
    re: /^(?:my\s+|show\s+(?:me\s+)?(?:my\s+)?|list\s+(?:my\s+)?)(?:labels?|tags?|categories)$/i,
    build: () => ({ intent: 'list_labels' }),
  },

  // Putting a message down until later. The time is captured as raw text and
  // resolved against the user's own timezone downstream — "tomorrow morning" is
  // a different instant in Nairobi than in New York.
  {
    re: /^(?:snooze|remind\s+me(?:\s+about\s+(?:this|it))?|defer|postpone|later)\s*(?:this|it)?\s*(.{0,60})$/i,
    build: (m) => ({ intent: 'snooze', until: m[1]!.trim() }),
  },

  {
    re: /^(?:summarize|summarise|tldr|sum\s?up)(?:\s+(?:this|it))?$/i,
    build: () => ({ intent: 'summarize' }),
  },
  {
    re: /^(?:read|speak|say)\s+(?:it\s+|this\s+)?(?:aloud|out\s+loud|to\s+me)$/i,
    build: () => ({ intent: 'read_aloud' }),
  },

  // Listing.
  {
    re: /^(?:show|list|what(?:'|’)?s?)\s+(?:me\s+)?(?:my\s+)?(?:the\s+)?today(?:'|’)?s?\s*(?:emails?)?$/i,
    build: () => ({ intent: 'list_today' }),
  },
  {
    re: /^(?:show|list)\s+(?:me\s+)?(?:my\s+)?unread(?:\s+emails?)?$/i,
    build: () => ({ intent: 'list_unread' }),
  },
  {
    // "what's urgent", "what is urgent", "anything urgent", "show urgent".
    re: /^(?:what(?:'|’)?s|what\s+is|anything|show|any)\s+urgent(?:\s+emails?)?\??$/i,
    build: () => ({ intent: 'list_urgent' }),
  },
  {
    re: /^(?:any\s+)?(?:missed\s+)?deadlines?\??$/i,
    build: () => ({ intent: 'list_deadlines' }),
  },

  // Search — checked before the question fallback so "search X" is not a question.
  {
    re: /^(?:search|find|look\s+for)\s+(?:for\s+)?(?:emails?\s+)?(.+)$/is,
    build: (m) => ({ intent: 'search', query: m[1]!.trim() }),
  },
  {
    re: /^(?:show|list)\s+(?:me\s+)?(?:all\s+)?emails?\s+from\s+(.+)$/is,
    build: (m) => ({ intent: 'search', query: `from:${m[1]!.trim()}` }),
  },
];

/**
 * Natural-language questions about the mailbox — "what did John ask me
 * yesterday?". Answered from stored analysis and embeddings, which is a read,
 * so it needs no confirmation.
 */
const QUESTION_RE =
  /^(?:what|who|when|where|why|how|did|does|is|are|was|were|has|have|can|should|any)\b.*\?*$/i;

export function parseCommand(raw: string): ParseResult {
  const text = raw.trim();

  if (!text) {
    return {
      intent: { intent: 'unknown', raw },
      source: 'deterministic',
      looksLikeReplyBody: false,
    };
  }

  const normalized = text
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim();

  // Bare yes/no. Only ever a reply when something is pending — the caller checks
  // conversation state; here we just classify.
  if (AFFIRMATIVE.has(normalized)) {
    return {
      intent: { intent: 'reply_affirmative' },
      source: 'deterministic',
      looksLikeReplyBody: false,
    };
  }
  if (NEGATIVE.has(normalized)) {
    return {
      intent: { intent: 'reply_negative' },
      source: 'deterministic',
      looksLikeReplyBody: false,
    };
  }

  const exact = EXACT_COMMANDS[normalized];
  if (exact) {
    return { intent: exact, source: 'deterministic', looksLikeReplyBody: false };
  }

  for (const { re, build } of PATTERNS) {
    const match = re.exec(text);
    if (match) {
      return { intent: build(match), source: 'deterministic', looksLikeReplyBody: false };
    }
  }

  if (QUESTION_RE.test(text) && text.length < 300) {
    return {
      intent: { intent: 'question', question: text },
      source: 'deterministic',
      looksLikeReplyBody: false,
    };
  }

  // Nothing matched. Long prose with no command verb is almost certainly the
  // body of a reply being dictated, which the caller can act on directly when a
  // thread is in context — and escalate to the model otherwise.
  return {
    intent: { intent: 'unknown', raw: text },
    source: 'deterministic',
    looksLikeReplyBody: looksLikeProse(text),
  };
}

function looksLikeProse(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  // A single long line with sentence-like structure.
  return words.length >= 3 && text.length > 15;
}

/**
 * True when acting on this intent needs an explicit confirmation tap.
 *
 * Not derived from the model's confidence, and not overridable by a caller —
 * these are the verbs whose consequences a user cannot undo (ADR 0004).
 */
export function needsConfirmation(intent: CommandIntent): boolean {
  return (
    intent.intent === 'delete' ||
    intent.intent === 'forward' ||
    // A compose is the most irreversible of the three. A delete goes to trash
    // and a forward at least names a message the user was looking at; a compose
    // has a typed address and nothing behind it, so nothing else in the system
    // is in a position to catch a mistake in it.
    intent.intent === 'compose'
  );
}
