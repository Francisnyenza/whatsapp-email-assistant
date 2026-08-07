import { describe, it, expect } from 'vitest';
import {
  TEMPLATES,
  buildTemplate,
  buildNewEmailTemplate,
  buildDigestTemplate,
  templateParameter,
  resolveTemplateLanguage,
  serializePayload,
} from '../src/index.js';

/**
 * Message templates.
 *
 * Outside the 24-hour window a free-form message is accepted by the API and then
 * never delivered — no error, no bounce, the user simply does not hear from us.
 * So everything here is guarding the same thing: a template that Meta rejects,
 * or one built with the wrong shape, means a notification nobody receives and
 * nothing anywhere saying so.
 */

describe('parameters', () => {
  it('collapses newlines, which Meta rejects outright', () => {
    // An email subject with a line break in it is entirely ordinary, and the
    // rejection takes the whole message, not just the parameter.
    expect(templateParameter('Q3 report\nand forecast')).toBe('Q3 report and forecast');
  });

  it('collapses tabs and long runs of spaces', () => {
    expect(templateParameter('Q3\treport')).toBe('Q3 report');
    expect(templateParameter('Q3     report')).toBe('Q3 report');
  });

  it('leaves ordinary single spaces alone', () => {
    expect(templateParameter('Q3 sales report')).toBe('Q3 sales report');
  });

  it('never produces an empty parameter', () => {
    // Meta rejects a blank one, so an absent value has to become something
    // readable rather than nothing.
    expect(templateParameter('')).toBe('—');
    expect(templateParameter('   \n  ')).toBe('—');
    expect(templateParameter('', '(no subject)')).toBe('(no subject)');
  });

  it('truncates rather than risking a rejected send', () => {
    const result = templateParameter('x'.repeat(500));
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves no forbidden whitespace behind, whatever goes in', () => {
    const hostile = 'Subject\r\n\twith \n\n\n    everything     in it';
    expect(templateParameter(hostile)).not.toMatch(/[\r\n\t]|\s{4,}/);
  });
});

describe('language', () => {
  const template = TEMPLATES.NEW_EMAIL;

  it('uses the exact locale when it was approved', () => {
    expect(resolveTemplateLanguage(template, 'fr')).toBe('fr');
  });

  it('accepts a hyphenated tag, because that is what browsers send', () => {
    expect(resolveTemplateLanguage(template, 'en-GB')).toBe('en_GB');
  });

  it('falls back to the same base language rather than to English', () => {
    // pt reaching a pt_BR template is far better than English.
    expect(resolveTemplateLanguage(template, 'pt')).toBe('pt_BR');
    expect(resolveTemplateLanguage(template, 'pt-PT')).toBe('pt_BR');
  });

  it('falls back to English for a language never submitted', () => {
    // An unapproved language code fails the send outright, so falling back in
    // code is the difference between a wrong language and no message.
    expect(resolveTemplateLanguage(template, 'is')).toBe('en');
  });

  it('falls back when there is no locale at all', () => {
    expect(resolveTemplateLanguage(template, undefined)).toBe('en');
  });
});

describe('building', () => {
  it('refuses the wrong number of parameters', () => {
    // A programming error that would fail 100% of sends. Better a stack trace
    // pointing at the caller than Meta's error later.
    expect(() => buildTemplate(TEMPLATES.NEW_EMAIL, ['only one'])).toThrow();
    expect(() => buildTemplate(TEMPLATES.NEW_EMAIL, ['a', 'b', 'c'])).toThrow();
  });

  it('names the template exactly as approved', () => {
    const payload = buildNewEmailTemplate({
      fromName: 'Sarah Chen',
      fromAddress: 'sarah@acme.com',
      subject: 'Q3 report',
    });

    expect(payload.name).toBe('new_email_notification');
    expect(payload.kind).toBe('template');
  });

  it('carries sender and subject in order', () => {
    const payload = buildNewEmailTemplate({
      fromName: 'Sarah Chen',
      fromAddress: 'sarah@acme.com',
      subject: 'Q3 report',
    });

    expect(payload.components![0]!.parameters.map((p) => p.text)).toEqual([
      'Sarah Chen',
      'Q3 report',
    ]);
  });

  it('uses the address when the sender has no display name', () => {
    const payload = buildNewEmailTemplate({
      fromAddress: 'sarah@acme.com',
      subject: 'Q3 report',
    });

    expect(payload.components![0]!.parameters[0]!.text).toBe('sarah@acme.com');
  });

  it('says "(no subject)" rather than sending an empty parameter', () => {
    const payload = buildNewEmailTemplate({ fromAddress: 'a@b.com', subject: '   ' });
    expect(payload.components![0]!.parameters[1]!.text).toBe('(no subject)');
  });

  it('sanitizes a subject that would have failed the send', () => {
    const payload = buildNewEmailTemplate({
      fromAddress: 'a@b.com',
      subject: 'Invoice\n\nattached',
    });

    expect(payload.components![0]!.parameters[1]!.text).toBe('Invoice attached');
  });

  it('builds the digest template with a count', () => {
    const payload = buildDigestTemplate({ count: 4, locale: 'fr' });

    expect(payload.name).toBe('email_digest_notification');
    expect(payload.languageCode).toBe('fr');
    expect(payload.components![0]!.parameters[0]!.text).toBe('4');
  });
});

describe('the wire format', () => {
  it('is what Meta expects', () => {
    const wire = serializePayload(
      buildNewEmailTemplate({
        fromName: 'Sarah Chen',
        fromAddress: 'sarah@acme.com',
        subject: 'Q3 report',
        locale: 'en-GB',
      }),
    ) as {
      type: string;
      template: { name: string; language: { code: string }; components: unknown[] };
    };

    expect(wire.type).toBe('template');
    expect(wire.template.name).toBe('new_email_notification');
    expect(wire.template.language).toEqual({ code: 'en_GB' });
    expect(wire.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Sarah Chen' },
          { type: 'text', text: 'Q3 report' },
        ],
      },
    ]);
  });
});

describe('the catalogue matches what was submitted', () => {
  /**
   * These mirror `docs/whatsapp-templates.md`. Meta approves a name, a language
   * and a placeholder count; drift between the doc and the code means every
   * send of that template fails, so the pairing is asserted rather than trusted.
   */
  it('declares the approved names', () => {
    expect(TEMPLATES.NEW_EMAIL.name).toBe('new_email_notification');
    expect(TEMPLATES.DIGEST.name).toBe('email_digest_notification');
  });

  it('declares the approved placeholder counts', () => {
    expect(TEMPLATES.NEW_EMAIL.parameterCount).toBe(2);
    expect(TEMPLATES.DIGEST.parameterCount).toBe(1);
  });

  it('uses names Meta accepts', () => {
    // Lower case and underscores only; Meta enforces this at submission.
    for (const template of Object.values(TEMPLATES)) {
      expect(template.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('lists English first, because it is the fallback', () => {
    for (const template of Object.values(TEMPLATES)) {
      expect(template.languages[0]).toBe('en');
    }
  });
});
