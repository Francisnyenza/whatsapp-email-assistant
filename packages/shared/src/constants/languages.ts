/**
 * Supported interface and translation languages.
 *
 * `whatsappTemplateCode` is Meta's language code for approved templates, which
 * does not always match ISO 639-1 (Chinese and Portuguese need regions).
 */

export interface SupportedLanguage {
  /** ISO 639-1. */
  code: string;
  name: string;
  nativeName: string;
  whatsappTemplateCode: string;
  rtl: boolean;
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English', whatsappTemplateCode: 'en', rtl: false },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', whatsappTemplateCode: 'sw', rtl: false },
  { code: 'fr', name: 'French', nativeName: 'Français', whatsappTemplateCode: 'fr', rtl: false },
  { code: 'es', name: 'Spanish', nativeName: 'Español', whatsappTemplateCode: 'es', rtl: false },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', whatsappTemplateCode: 'ar', rtl: true },
  { code: 'zh', name: 'Chinese', nativeName: '中文', whatsappTemplateCode: 'zh_CN', rtl: false },
  {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    whatsappTemplateCode: 'pt_BR',
    rtl: false,
  },
  { code: 'de', name: 'German', nativeName: 'Deutsch', whatsappTemplateCode: 'de', rtl: false },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', whatsappTemplateCode: 'ja', rtl: false },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', whatsappTemplateCode: 'hi', rtl: false },
] as const;

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

export const DEFAULT_LANGUAGE = 'en';

export function isSupportedLanguage(code: string): boolean {
  return SUPPORTED_LANGUAGE_CODES.includes(code.toLowerCase());
}

export function getLanguage(code: string): SupportedLanguage | undefined {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code.toLowerCase());
}

/**
 * Resolves a user-typed language name to a code — "translate to Swahili",
 * "kiswahili", "sw" all resolve to `sw`. Returns undefined rather than guessing.
 */
export function resolveLanguage(input: string): SupportedLanguage | undefined {
  const needle = input.trim().toLowerCase();
  if (!needle) return undefined;
  return SUPPORTED_LANGUAGES.find(
    (l) =>
      l.code === needle ||
      l.name.toLowerCase() === needle ||
      l.nativeName.toLowerCase() === needle ||
      // "kiswahili" → "swahili"
      l.nativeName.toLowerCase().replace(/^ki/, '') === needle,
  );
}
