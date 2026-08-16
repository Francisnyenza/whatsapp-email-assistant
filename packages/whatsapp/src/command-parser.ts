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
    // "email alice@x.com cc bob@x.com about Q3 saying …" — the copy list sits
    // between the recipient and the subject, which is where people put it.
    re: /^(?:new\s+)?(?:e-?mail|mail|message|write\s+to|send\s+(?:an?\s+)?(?:e-?mail\s+)?to)\s+(?:to\s+)?(\S+@\S+?)\s+(?:cc|copy(?:ing)?)\s+([^]+?)\s+(?:about\s+(.{1,200}?)\s+)?(?:saying|that\s+says|:)\s+(.+)$/is,
    build: (m) => ({
      intent: 'compose',
      to: m[1]!.trim().replace(/[,;]$/, ''),
      cc: m[2]!.trim(),
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
  return intent.intent === 'delete' || intent.intent === 'forward';
}
