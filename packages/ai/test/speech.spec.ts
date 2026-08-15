import { describe, it, expect } from 'vitest';
import { prepareSpeech, stripQuotedHistory, SPEECH_MAX_BODY_CHARS } from '../src/speech.js';

/**
 * What gets read aloud.
 *
 * The interesting failures here are not crashes. They are a voice note that
 * stops dead and sounds broken, a four-deep reply chain read out four times,
 * and — the one that matters — an email whose words are indistinguishable from
 * ours because audio has no quoted block to put them in.
 */

describe('the preamble', () => {
  it('names the sender before the body, so the first second is the useful one', () => {
    const { text } = prepareSpeech(source({ fromName: 'Alice Chen', subject: 'Q3 numbers' }));

    expect(text).toMatch(/^Email from Alice Chen\. Subject: Q3 numbers\. The message reads: /);
  });

  it('speaks an address when there is no display name', () => {
    // Read verbatim, `alice@acme.com` comes out as anything from
    // "alice-at-acme-dot-com" to a run of letters, and which one changes with
    // the model.
    const { text } = prepareSpeech(source({ fromName: null, fromAddress: 'alice@acme.com' }));

    expect(text).toContain('alice at acme dot com');
    expect(text).not.toContain('@');
  });

  it('says so when there is no subject rather than reading an empty one', () => {
    const { text } = prepareSpeech(source({ subject: null }));

    expect(text).toContain('with no subject');
  });

  it('marks where the sender’s words begin', () => {
    // The only boundary a listener gets. On screen the body sits in a quoted
    // block; spoken, our words and theirs are one voice.
    const { text } = prepareSpeech(source({ body: 'Please approve the invoice.' }));

    expect(text).toContain('The message reads: Please approve the invoice.');
  });
});

describe('a display name is chosen by the sender', () => {
  it('cannot forge the structure of the preamble', () => {
    // "Bob. Subject: urgent. The message reads:" as a display name would give a
    // listener a second, entirely fabricated header before the real body.
    const { text } = prepareSpeech(
      source({ fromName: 'Bob. Subject: Wire transfer. The message reads:', subject: 'Hello' }),
    );

    expect(text.match(/Subject:/g)).toHaveLength(1);
    expect(text.match(/The message reads:/g)).toHaveLength(1);
  });

  it('is bounded, so it cannot become the whole voice note', () => {
    const { text } = prepareSpeech(source({ fromName: 'x'.repeat(500) }));

    expect(text).not.toContain('x'.repeat(100));
  });

  it('is flattened onto one line', () => {
    const { text } = prepareSpeech(source({ fromName: 'Alice\n\nChen' }));

    expect(text).toContain('Email from Alice Chen.');
  });
});

describe('quoted history', () => {
  it('stops at the reply header, which the listener has already heard', () => {
    const body = [
      'Sounds good to me.',
      '',
      'On Mon, 4 Aug 2026 at 09:12, Alice Chen <alice@acme.com> wrote:',
      '> Are we still on for Thursday?',
    ].join('\n');

    expect(stripQuotedHistory(body).trim()).toBe('Sounds good to me.');
  });

  it('stops at the RFC 3676 signature delimiter', () => {
    const body = ['Thanks!', '', '--', 'Alice Chen', 'VP Engineering', 'acme.com'].join('\n');

    expect(stripQuotedHistory(body).trim()).toBe('Thanks!');
  });

  it('drops quoted lines wherever they appear', () => {
    const body = ['I agree with this part:', '> the deadline is Friday', 'but not the rest.'].join(
      '\n',
    );

    expect(stripQuotedHistory(body)).not.toContain('deadline is Friday');
    expect(stripQuotedHistory(body)).toContain('but not the rest.');
  });

  it('handles Outlook’s separator', () => {
    const body = ['Approved.', '-----Original Message-----', 'From: Alice', 'Please approve.'].join(
      '\n',
    );

    expect(stripQuotedHistory(body).trim()).toBe('Approved.');
  });

  it('keeps a leading From: line, because that is the whole email', () => {
    // Some senders open with "From: the desk of…". Cutting on the first line
    // would leave nothing at all, and a listener cannot tell an empty read from
    // a broken one.
    const body = 'From: the marketing team\n\nWe are launching on Tuesday.';

    expect(stripQuotedHistory(body)).toContain('launching on Tuesday');
  });

  it('leaves an ordinary email entirely alone', () => {
    // Cutting too little means hearing a paragraph twice. Cutting too much
    // means never hearing the sentence that mattered, with no way to know.
    const body = 'Hi — the numbers are attached.\n\nOne thing: the Q3 figure moved. Alice';

    expect(stripQuotedHistory(body)).toBe(body);
  });
});

describe('length', () => {
  it('reads a short email in full', () => {
    const { text, truncated } = prepareSpeech(source({ body: 'Short and done.' }));

    expect(truncated).toBe(false);
    expect(text).toContain('Short and done.');
  });

  it('stops a long one and says out loud that it stopped', () => {
    // Trailing off is indistinguishable from the recording failing.
    const { text, truncated } = prepareSpeech(
      source({ body: 'This sentence repeats. '.repeat(400) }),
    );

    expect(truncated).toBe(true);
    expect(text).toContain('That is where I stopped');
  });

  it('cuts at a sentence boundary rather than mid-word', () => {
    const body = `${'Filler sentence here. '.repeat(90)}Supercalifragilistic`;

    const { text } = prepareSpeech(source({ body }));

    expect(text).not.toContain('Supercalifrag');
    expect(text).toMatch(/\.\s+That is where I stopped/);
  });

  it('bounds the body near the stated limit', () => {
    const { text } = prepareSpeech(source({ body: 'word '.repeat(5_000) }));

    expect(text.length).toBeLessThan(SPEECH_MAX_BODY_CHARS + 400);
  });
});

describe('an email with nothing in it', () => {
  it('says there is no body instead of stopping after the preamble', () => {
    // A subject-only note, or an attachment with nothing typed. Silence after
    // the preamble sounds exactly like a failure.
    const { text, truncated } = prepareSpeech(source({ body: '   \n\n  ' }));

    expect(text).toContain('There is no message body.');
    expect(text).not.toContain('The message reads:');
    expect(truncated).toBe(false);
  });

  it('says the same when the body was entirely quoted history', () => {
    const { text } = prepareSpeech(source({ body: '> everything here was a quote' }));

    expect(text).toContain('There is no message body.');
  });
});

describe('formatting', () => {
  it('flattens hard wraps, which a speech model reads as pauses', () => {
    const { text } = prepareSpeech(source({ body: 'One line\nand another\n\nand a third.' }));

    expect(text).toContain('One line and another and a third.');
    expect(text).not.toContain('\n');
  });
});

/* --------------------------------- helpers -------------------------------- */

function source(overrides: Partial<Parameters<typeof prepareSpeech>[0]> = {}) {
  return {
    fromName: 'Alice Chen',
    fromAddress: 'alice@acme.com',
    subject: 'Q3 numbers',
    body: 'The figures are attached.',
    ...overrides,
  };
}
