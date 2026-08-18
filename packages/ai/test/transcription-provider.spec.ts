import { describe, it, expect, vi } from 'vitest';
import { OpenAiProvider, GeminiProvider, AnthropicProvider, canTranscribe } from '../src/index.js';

/**
 * Turning a voice note into words.
 *
 * The filename is the whole risk, and it is not obvious: Whisper picks its
 * decoder from the *extension*, not from the content type. A WhatsApp voice
 * note is Ogg-Opus, and sending one as `voice-note.mp3` is rejected with a
 * message about the format that says nothing about the cause.
 */

describe('which providers can transcribe', () => {
  it('OpenAI can', () => {
    expect(canTranscribe(new OpenAiProvider({ apiKey: 'k' }))).toBe(true);
  });

  it('Gemini and Anthropic say so up front rather than throwing later', () => {
    // Anthropic publishes none. Gemini's is a multimodal completion rather than
    // an endpoint taking an audio file — different enough that a shim belongs
    // in a provider of its own, not in the port.
    expect(canTranscribe(new GeminiProvider({ apiKey: 'k' }))).toBe(false);
    expect(canTranscribe(new AnthropicProvider({ apiKey: 'k' }))).toBe(false);
  });
});

describe('the request', () => {
  it('names the file by its real format, which is what picks the decoder', async () => {
    const { provider, calls } = build({ text: 'meet me at six' });

    await provider.transcribe({ audio: Buffer.from('OggS'), mimeType: 'audio/ogg; codecs=opus' });

    const form = calls[0]!.body as FormData;
    expect((form.get('file') as File).name).toBe('voice-note.ogg');
  });

  it('maps the other formats a phone might send', async () => {
    for (const [mimeType, expected] of [
      ['audio/mpeg', 'voice-note.mp3'],
      ['audio/mp4', 'voice-note.m4a'],
      ['audio/aac', 'voice-note.m4a'],
      ['audio/wav', 'voice-note.wav'],
    ] as const) {
      const { provider, calls } = build({ text: 'x' });
      await provider.transcribe({ audio: Buffer.from('x'), mimeType });
      expect(((calls[0]!.body as FormData).get('file') as File).name).toBe(expected);
    }
  });

  it('passes a language only when one was given', async () => {
    // Forcing the wrong one produces a confident English transcription of
    // Swahili, which nothing downstream can tell from a correct one.
    const { provider, calls } = build({ text: 'x' });
    await provider.transcribe({ audio: Buffer.from('x'), mimeType: 'audio/ogg' });
    expect((calls[0]!.body as FormData).get('language')).toBeNull();

    const second = build({ text: 'x' });
    await second.provider.transcribe({
      audio: Buffer.from('x'),
      mimeType: 'audio/ogg',
      language: 'sw',
    });
    expect((second.calls[0]!.body as FormData).get('language')).toBe('sw');
  });
});

describe('the answer', () => {
  it('returns the words, trimmed', async () => {
    const { provider } = build({ text: '  meet me at six  ' });

    const result = await provider.transcribe({
      audio: Buffer.from('x'),
      mimeType: 'audio/ogg',
    });

    expect(result.text).toBe('meet me at six');
  });

  it('carries the detected language when the model says', async () => {
    const { provider } = build({ text: 'karibu', language: 'swahili' });

    expect(
      (await provider.transcribe({ audio: Buffer.from('x'), mimeType: 'audio/ogg' })).language,
    ).toBe('swahili');
  });

  it('refuses empty audio without paying for the round trip', async () => {
    const { provider, calls } = build({ text: 'x' });

    await expect(
      provider.transcribe({ audio: Buffer.alloc(0), mimeType: 'audio/ogg' }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('says plainly when it made out no words at all', async () => {
    // Silence, or speech it could not parse. A real outcome the caller has to
    // answer for, not an error to swallow.
    const { provider } = build({ text: '   ' });

    await expect(
      provider.transcribe({ audio: Buffer.from('x'), mimeType: 'audio/ogg' }),
    ).rejects.toMatchObject({ publicMessage: expect.stringContaining("couldn't make out") });
  });

  it('reports zero tokens rather than inventing a count', async () => {
    // The endpoint bills by audio duration and reports no token usage.
    const { provider } = build({ text: 'hello' });

    const { usage } = await provider.transcribe({
      audio: Buffer.from('x'),
      mimeType: 'audio/ogg',
    });

    expect(usage.totalTokens).toBe(0);
    expect(usage.model).toBe('whisper-1');
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(body: { text: string; language?: string }) {
  const calls: Array<{ url: string; body: unknown }> = [];

  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, body: init.body });
    return { ok: true, status: 200, json: async () => body };
  });

  return { provider: new OpenAiProvider({ apiKey: 'k', fetchImpl: fetchImpl as never }), calls };
}
