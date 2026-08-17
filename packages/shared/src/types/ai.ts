import { z } from 'zod';

/**
 * AI contracts.
 *
 * Every model response is parsed against a Zod schema before it is used. A
 * response that fails validation is discarded, never coerced — model output must
 * not become a query parameter, a header value or a provider call argument
 * (ADR 0004).
 */

export const emailCategorySchema = z.enum([
  'primary',
  'work',
  'personal',
  'finance',
  'invoice',
  'travel',
  'shopping',
  'social',
  'newsletter',
  'promotion',
  'notification',
  'support',
  'recruitment',
  'legal',
  'spam',
  'other',
]);

export const emailPrioritySchema = z.enum(['urgent', 'high', 'normal', 'low']);

export const extractedEntitySchema = z.object({
  type: z.enum([
    'phone',
    'address',
    'meeting_time',
    'deadline',
    'invoice',
    'amount',
    'url',
    'person',
    'organization',
    'tracking_number',
  ]),
  value: z.string().max(500),
  /** Verbatim span from the email that produced this, for user verification. */
  context: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1),
});

export const actionItemSchema = z.object({
  description: z.string().max(300),
  /** ISO 8601 date when one was stated; we never invent a due date. */
  dueDate: z.string().datetime().optional(),
  assignedToUser: z.boolean(),
});

/**
 * The single structured analysis produced per inbound email. One model call
 * fills all of it — a call per feature would be both slower and far more
 * expensive at 50 M emails/day.
 */
export const emailAnalysisSchema = z.object({
  summary: z.string().max(600),
  bulletSummary: z.array(z.string().max(200)).max(6),
  category: emailCategorySchema,
  priority: emailPrioritySchema,
  /** 0 = routine, 1 = needs attention right now. */
  urgencyScore: z.number().min(0).max(1),
  /** 0 = certainly legitimate, 1 = certainly spam. */
  spamScore: z.number().min(0).max(1),
  /** ISO 639-1. */
  language: z.string().length(2),
  requiresReply: z.boolean(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'urgent']),
  entities: z.array(extractedEntitySchema).max(30),
  actionItems: z.array(actionItemSchema).max(15),
  /** Short reply options offered as WhatsApp buttons. */
  suggestedReplies: z.array(z.string().max(120)).max(3),
  /**
   * True when the body contains text attempting to instruct an automated
   * assistant. Surfaced to the user as a warning; never acted on (ADR 0004).
   */
  containsInstructionLikeText: z.boolean().default(false),
});

export type EmailAnalysis = z.infer<typeof emailAnalysisSchema>;
export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;

export const draftedReplySchema = z.object({
  bodyText: z.string().max(5000),
  tone: z.enum(['formal', 'friendly', 'concise', 'apologetic', 'enthusiastic', 'neutral']),
  language: z.string().length(2),
});

export type DraftedReply = z.infer<typeof draftedReplySchema>;

/* ------------------------------ command intent ----------------------------- */

/**
 * Intents parsed from a *user's WhatsApp message* — never from email content.
 * The deterministic parser handles most traffic; the model classifier is the
 * fallback.
 */
export const commandIntentSchema = z.discriminatedUnion('intent', [
  z.object({
    intent: z.literal('reply'),
    body: z.string().optional(),
    target: z.string().optional(),
    /**
     * Copy everyone the original was addressed to.
     *
     * Opt-in, and it has to be: quietly copying five people on a reply the user
     * thought was private is not recoverable. `resolveReplyRecipients` has
     * implemented this from the start and nothing ever set it — the capability
     * was built, tested and unreachable.
     */
    replyAll: z.boolean().optional(),
  }),
  z.object({ intent: z.literal('reply_affirmative') }),
  z.object({ intent: z.literal('reply_negative') }),
  z.object({ intent: z.literal('draft'), instruction: z.string().optional() }),
  /**
   * A brand-new email, to someone the user names. Distinct from `draft`, which
   * composes a *reply* — `compose` and `write` were long-standing aliases for
   * that, and the absence of this intent was the largest gap in the product.
   *
   * `to` is the raw text the user typed, deliberately not parsed here: the
   * parser's job is recognising the shape of a request, and turning text into an
   * address we are willing to send to is `parseRecipientList`'s, which refuses
   * rather than repairs. Validating in two places means one of them is laxer.
   */
  z.object({
    intent: z.literal('compose'),
    to: z.string(),
    /** Raw text again, validated downstream by the same parser as `to`. */
    cc: z.string().optional(),
    /**
     * Blind copies. Same raw text, same validation — the only difference is
     * that the other recipients never see this list, which is precisely why the
     * sender has to.
     */
    bcc: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
  }),
  /** "send me the attachment" — the files on an email, into the chat. */
  z.object({ intent: z.literal('get_attachment') }),
  /**
   * "drop the files" — the other direction. Files the user sent into the chat
   * wait for the next email they send, so there has to be a way to say that the
   * next email is not the one they were for.
   */
  z.object({ intent: z.literal('discard_files') }),
  z.object({ intent: z.literal('send') }),
  z.object({ intent: z.literal('cancel') }),
  z.object({ intent: z.literal('undo') }),
  z.object({ intent: z.literal('archive'), target: z.string().optional() }),
  z.object({ intent: z.literal('delete'), target: z.string().optional() }),
  z.object({ intent: z.literal('forward'), recipient: z.string(), target: z.string().optional() }),
  z.object({ intent: z.literal('mark_read'), read: z.boolean() }),
  z.object({ intent: z.literal('mark_important'), important: z.boolean() }),
  z.object({ intent: z.literal('summarize'), target: z.string().optional() }),
  z.object({ intent: z.literal('translate'), language: z.string() }),
  z.object({ intent: z.literal('read_aloud'), target: z.string().optional() }),
  z.object({ intent: z.literal('search'), query: z.string() }),
  z.object({ intent: z.literal('list_today') }),
  z.object({ intent: z.literal('list_unread') }),
  z.object({ intent: z.literal('list_urgent') }),
  z.object({ intent: z.literal('list_deadlines') }),
  z.object({ intent: z.literal('question'), question: z.string() }),
  z.object({ intent: z.literal('help') }),
  z.object({ intent: z.literal('unknown'), raw: z.string() }),
]);

export type CommandIntent = z.infer<typeof commandIntentSchema>;
export type CommandIntentName = CommandIntent['intent'];

/**
 * Verbs that mutate a mailbox or send mail on the user's behalf. Each requires
 * an explicit confirmation tap carrying a server-minted target id — the model
 * cannot authorize any of them (ADR 0004).
 */
export const DESTRUCTIVE_INTENTS: readonly CommandIntentName[] = [
  'delete',
  'forward',
  'send',
] as const;

/* ------------------------------ provider port ------------------------------ */

export type AiTaskClass = 'analysis' | 'composition' | 'classification' | 'embedding';

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
  latencyMs: number;
  /** Estimated cost in USD micro-units (1e-6 USD), for per-user metering. */
  costMicros: number;
}

export interface AiResult<T> {
  data: T;
  usage: AiUsage;
  /** True when this was served from the content-hash cache; usage is then zero. */
  cached: boolean;
}
