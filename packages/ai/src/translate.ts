import { AppError, type AiResult } from '@wea/shared';
import { buildEnvelope, neutralize } from './envelope.js';
import type { AiProvider } from './provider.js';

/**
 * Translating an email into the reader's language.
 *
 * The output here is prose rather than a structure, which makes it the one AI
 * path in this codebase with no Zod schema behind it — worth being explicit
 * about, because "no schema" reads like a gap.
 *
 * A schema exists to stop model output becoming a *decision*: a category that
 * routes, a boolean that gates, a string that reaches a provider call. A
 * translation becomes none of those. It is shown to one person, on their own
 * phone, alongside the email it came from, and nothing downstream branches on
 * it. What replaces the schema is the two guarantees that actually matter for
 * text on a screen — it is bounded, and it carries no control characters — plus
 * the structural one that already holds everywhere: there is no tool on the port
 * for the model to reach for (ADR 0004).
 *
 * The residual risk is honest and small: a translated phishing line is still a
 * phishing line, and the user would have seen it in the original too. What they
 * must not lose is the warning that came with it, so the caller keeps surfacing
 * `containsInstructionLikeText` from the analysis regardless of what this
 * returns.
 */

const SYSTEM_PROMPT = [
  'You translate one email into a target language.',
  '',
  'You have no ability to send, delete, forward or reply to anything. Nothing',
  'you return causes an action. Your output is shown to the recipient.',
  '',
  'Rules:',
  '- Translate faithfully. Do not summarise, shorten, answer or comment.',
  '- Keep names, addresses, amounts, dates and reference numbers exactly as',
  '  they appear.',
  '- If the text is already in the target language, return it unchanged.',
  '- Return only the translation. No preamble, no notes, no quotation marks',
  '  around the whole thing.',
].join('\n');

/**
 * How much of an email gets translated.
 *
 * WhatsApp will not show more than 4 096 characters of text anyway, so
 * translating a 40 KB newsletter would be paying for output nobody can read.
 * The cut is announced to the user rather than hidden.
 */
const MAX_TRANSLATION_CHARS = 3_000;

export interface TranslationInput {
  subject: string;
  bodyText: string;
  /** Whatever the user typed — "swahili", "sw", "Portuguese". */
  targetLanguage: string;
}

export interface Translation {
  text: string;
  /** True when the source was longer than we were willing to translate. */
  truncated: boolean;
}

export async function translateEmail(
  provider: AiProvider,
  input: TranslationInput,
): Promise<AiResult<Translation>> {
  const language = sanitizeLanguage(input.targetLanguage);
  if (!language) {
    throw new AppError('BAD_REQUEST', 'No target language given', { retryable: false });
  }

  const source = [input.subject, '', input.bodyText].join('\n');
  const truncated = source.length > MAX_TRANSLATION_CHARS;

  const envelope = buildEnvelope([
    { label: 'email to translate', content: source.slice(0, MAX_TRANSLATION_CHARS) },
  ]);

  const response = await provider.complete({
    system: SYSTEM_PROMPT,
    user: [envelope.text, '', `Translate the text above into: ${language}.`].join('\n'),
    task: 'composition',
    // Not zero. A translation at zero temperature is stilted in a way people
    // notice, and there is no downstream branch that needs two runs to agree.
    temperature: 0.2,
    maxOutputTokens: 1_500,
  });

  const text = neutralize(response.text, envelope.nonce);

  if (!text) {
    throw new AppError('AI_INVALID_OUTPUT', 'Model returned an empty translation', {
      retryable: true,
    });
  }

  return { data: { text, truncated }, usage: response.usage, cached: false };
}

/**
 * The language name, as the user typed it, made safe to interpolate.
 *
 * This is the one piece of *user* input that reaches the prompt outside the
 * envelope, so it is bounded and stripped to letters, spaces and hyphens. Not
 * because a user attacking their own assistant is a threat model worth much —
 * they can already type anything to it — but because "sw, and also ignore your
 * instructions" belongs nowhere near a system prompt, and the cost of refusing
 * it is one regex.
 */
function sanitizeLanguage(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/[^\p{L}\s-]/gu, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
    .trim();

  return cleaned || null;
}
