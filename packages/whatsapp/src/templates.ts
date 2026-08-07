import { AppError, type WhatsAppTemplatePayload } from '@wea/shared';

/**
 * Message templates, and the rules for filling them in.
 *
 * Outside Meta's 24-hour customer service window a free-form message is
 * *accepted by the API and then never delivered*. So a template is the only way
 * to tell someone their mail arrived when they have not messaged us recently —
 * which, for a notification product, is most of the time.
 *
 * A template is not something this code defines. It is submitted to Meta,
 * reviewed by a human, and approved against a fixed name, language and
 * placeholder count. What lives here is a declaration of what was approved, so
 * the two cannot drift: send a name that was never approved, or the wrong number
 * of placeholders, and every message fails. The exact text submitted is in
 * `docs/whatsapp-templates.md`, and changing either without the other is the
 * mistake this file exists to make hard.
 *
 * The template is deliberately a nudge rather than the content. Its text is
 * fixed at approval time, so it cannot carry a summary, buttons that act, or
 * anything else the product actually does. Its whole job is to get the user to
 * reply — which reopens the window, after which the real card can be sent.
 */

export interface TemplateDefinition {
  /** Exactly as approved. Meta matches on this string. */
  name: string;
  /** How many `{{n}}` placeholders the approved body contains. */
  parameterCount: number;
  /** Language codes approved for this template. The first is the fallback. */
  languages: readonly string[];
}

export const TEMPLATES = {
  /** "New email from {{1}}: {{2}}. Reply to this message to read and answer it." */
  NEW_EMAIL: {
    name: 'new_email_notification',
    parameterCount: 2,
    languages: ['en', 'en_GB', 'es', 'fr', 'pt_BR', 'de', 'ar', 'hi', 'sw', 'zh_CN'],
  },
  /** "You have {{1}} new emails waiting. Reply to this message to see them." */
  DIGEST: {
    name: 'email_digest_notification',
    parameterCount: 1,
    languages: ['en', 'en_GB', 'es', 'fr', 'pt_BR', 'de', 'ar', 'hi', 'sw', 'zh_CN'],
  },
} as const satisfies Record<string, TemplateDefinition>;

/**
 * Meta rejects a parameter containing a newline, a tab, or four or more
 * consecutive spaces — the whole message, not just the parameter. An email
 * subject with a line break in it is entirely ordinary, so this is not a rare
 * edge: it is Tuesday.
 */
const FORBIDDEN_WHITESPACE = /[\r\n\t]+|\s{4,}/g;

/**
 * Parameters are capped well below Meta's own limit. A 900-character subject
 * would be truncated on the device anyway, and a template that fails to render
 * tells the user nothing at all.
 */
const MAX_PARAMETER_LENGTH = 200;

/**
 * Prepares one parameter value.
 *
 * Empty is not allowed either — Meta rejects a blank parameter — so an absent
 * value becomes a readable placeholder rather than a failed send. A notification
 * saying "(no subject)" is useful; one that never arrives is not.
 */
export function templateParameter(value: string, fallback = '—'): string {
  const cleaned = value.replace(FORBIDDEN_WHITESPACE, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > MAX_PARAMETER_LENGTH
    ? `${cleaned.slice(0, MAX_PARAMETER_LENGTH - 1).trimEnd()}…`
    : cleaned;
}

/**
 * Picks the approved language closest to the user's.
 *
 * Meta treats `en` and `en_GB` as separate templates, each approved separately,
 * so a locale we never submitted must fall back rather than be sent — an
 * unapproved language code fails the send outright. Matching is by base language
 * when the exact tag is not approved, because `pt` reaching a `pt_BR` template
 * is far better than English.
 */
export function resolveTemplateLanguage(
  template: TemplateDefinition,
  locale: string | undefined,
): string {
  const fallback = template.languages[0]!;
  if (!locale) return fallback;

  const normalized = locale.replace('-', '_');
  if (template.languages.includes(normalized)) return normalized;

  const base = normalized.split('_')[0]!;
  return template.languages.find((code) => code.split('_')[0] === base) ?? fallback;
}

/**
 * Builds a template message.
 *
 * @throws {AppError} when the parameter count does not match what was approved.
 *   That is a programming error rather than a runtime condition, and it fails
 *   100% of sends — so it is worth failing loudly here, where the stack trace
 *   points at the caller, rather than reading Meta's error later.
 */
export function buildTemplate(
  template: TemplateDefinition,
  parameters: string[],
  locale?: string,
): WhatsAppTemplatePayload {
  if (parameters.length !== template.parameterCount) {
    throw new AppError(
      'BAD_REQUEST',
      `Template ${template.name} takes ${template.parameterCount} parameters, got ${parameters.length}`,
      { retryable: false },
    );
  }

  return {
    kind: 'template',
    name: template.name,
    languageCode: resolveTemplateLanguage(template, locale),
    ...(parameters.length
      ? {
          components: [
            {
              type: 'body' as const,
              parameters: parameters.map((text) => ({
                type: 'text' as const,
                text: templateParameter(text),
              })),
            },
          ],
        }
      : {}),
  };
}

/** The out-of-window nudge for a single email. */
export function buildNewEmailTemplate(input: {
  fromName?: string;
  fromAddress: string;
  subject: string;
  locale?: string;
}): WhatsAppTemplatePayload {
  return buildTemplate(
    TEMPLATES.NEW_EMAIL,
    [
      templateParameter(input.fromName ?? input.fromAddress, input.fromAddress),
      templateParameter(input.subject, '(no subject)'),
    ],
    input.locale,
  );
}

/** The out-of-window nudge for a batch. */
export function buildDigestTemplate(input: {
  count: number;
  locale?: string;
}): WhatsAppTemplatePayload {
  return buildTemplate(TEMPLATES.DIGEST, [String(input.count)], input.locale);
}
