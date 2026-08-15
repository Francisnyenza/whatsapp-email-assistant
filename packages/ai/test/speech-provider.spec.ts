import { describe, it, expect, vi } from 'vitest';
import { OpenAiProvider, GeminiProvider, AnthropicProvider, canSpeak } from '../src/index.js';

/**
 * Turning text into audio a phone will actually play.
 *
 * The format is the whole risk. An MP3 uploads to WhatsApp without complaint
 * and arrives as a file attachment nobody opens; only Ogg-encapsulated Opus
 * renders as a voice note. Both paths return 200, so nothing but an assertion
 * on the request itself catches the difference before a user does.
 */

describe('which providers can speak', () => {
  it('OpenAI can', () => {
    expect(canSpeak(new OpenAiProvider({ apiKey: 'k' }))).toBe(true);
  });

  it('Gemini and Anthropic say so up front rather than throwing later', () => {
    // Anthropic publishes no speech API. Gemini's returns raw 24 kHz PCM, which
    // WhatsApp cannot play and we have no transcoder for. A method that could
    // only ever fail costs a caller a round trip to learn something knowable
    // now — so it is absent, exactly as `embed` is on Anthropic.
    expect(canSpeak(new GeminiProvider({ apiKey: 'k' }))).toBe(false);
    expect(canSpeak(new AnthropicProvider({ apiKey: 'k' }))).toBe(false);
  });

  it('narrows the type, so a caller needs no assertion afterwards', () => {
    const provider = new OpenAiProvider({ apiKey: 'k' });

    if (!canSpeak(provider)) throw new Error('unreachable');

    expect(typeof provider.speak).toBe('function');
  });
});

describe('the request', () => {
  it('asks for Opus, which is the only thing WhatsApp plays as a voice note', async () => {
    const { provider, calls } = build(audio());

    await provider.speak({ text: 'Hello there.' });

    expect(body(calls[0]!).response_format).toBe('opus');
  });

  it('reports the type it actually received, not a constant', async () => {
    const { provider } = build(audio());

    const result = await provider.speak({ text: 'Hello there.' });

    expect(result.mimeType).toBe('audio/ogg');
  });

  it('goes to the speech endpoint', async () => {
    const { provider, calls } = build(audio());

    await provider.speak({ text: 'Hello there.' });

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
  });

  it('uses the configured voice, and a default when there is none', async () => {
    const withVoice = build(audio(), { speechVoice: 'nova' });
    await withVoice.provider.speak({ text: 'Hi.' });
    expect(body(withVoice.calls[0]!).voice).toBe('nova');

    const plain = build(audio());
    await plain.provider.speak({ text: 'Hi.' });
    expect(body(plain.calls[0]!).voice).toBe('alloy');
  });

  it('lets a single call override the voice', async () => {
    const { provider, calls } = build(audio(), { speechVoice: 'nova' });

    await provider.speak({ text: 'Hi.', voice: 'shimmer' });

    expect(body(calls[0]!).voice).toBe('shimmer');
  });

  it('bounds the text the endpoint would otherwise reject outright', async () => {
    // Past its ceiling the endpoint refuses the whole request, so an
    // unbounded long email produces an error rather than a shorter voice note.
    const { provider, calls } = build(audio());

    await provider.speak({ text: 'x'.repeat(50_000) });

    expect(String(body(calls[0]!).input).length).toBeLessThanOrEqual(4_000);
  });

  it('refuses empty text without spending a call', async () => {
    // Every provider bills for it and returns silence — which is also what a
    // failed read sounds like, so refusing keeps the two apart for the caller.
    const { provider, calls } = build(audio());

    await expect(provider.speak({ text: '   ' })).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('what comes back', () => {
  it('is carried as bytes, not decoded or re-encoded', async () => {
    const bytes = audio();
    const { provider } = build(bytes);

    const result = await provider.speak({ text: 'Hello.' });

    expect(Buffer.compare(result.audio, bytes)).toBe(0);
  });

  it('treats a 200 with no audio as a failure worth retrying', async () => {
    // Uploading zero bytes to WhatsApp fails with a less useful message than
    // this one, several steps further from the cause.
    const { provider } = build(Buffer.alloc(0));

    await expect(provider.speak({ text: 'Hello.' })).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
      retryable: true,
    });
  });
});

describe('metering a call that reports no usage', () => {
  it('charges the daily token budget an estimate rather than nothing', async () => {
    // The speech endpoint returns audio and no usage object. Leaving it out of
    // the budget entirely would make repeated "read that aloud" the one request
    // in the product with no ceiling — which is the runaway the ceiling exists
    // to catch.
    const { provider } = build(audio());

    const { usage } = await provider.speak({ text: 'x'.repeat(400) });

    expect(usage.totalTokens).toBe(100);
    expect(usage.promptTokens).toBe(100);
  });

  it('prices exactly, because characters are counted rather than estimated', async () => {
    const { provider } = build(audio(), { speechModel: 'tts-1' });

    const { usage } = await provider.speak({ text: 'x'.repeat(1_000_000) });

    // Bounded to 4 000 characters before it is sent, and priced on what was
    // actually sent — metering the pre-truncation length would bill for text
    // that was never spoken.
    expect(usage.costMicros).toBe(60_000);
    expect(usage.model).toBe('tts-1');
  });

  it('meters an unknown model at zero rather than guessing a price', async () => {
    const { provider } = build(audio(), { speechModel: 'tts-9-unreleased' });

    const { usage } = await provider.speak({ text: 'Hello.' });

    expect(usage.costMicros).toBe(0);
    expect(usage.totalTokens).toBeGreaterThan(0);
  });
});

describe('failures', () => {
  it('marks a rate limit retryable and a bad request not', async () => {
    const limited = build(audio(), {}, 429);
    await expect(limited.provider.speak({ text: 'Hi.' })).rejects.toMatchObject({
      retryable: true,
    });

    const refused = build(audio(), {}, 400);
    await expect(refused.provider.speak({ text: 'Hi.' })).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('treats an unreachable provider as retryable', async () => {
    const provider = new OpenAiProvider({
      apiKey: 'k',
      fetchImpl: (() => Promise.reject(new Error('ECONNRESET'))) as never,
    });

    await expect(provider.speak({ text: 'Hi.' })).rejects.toMatchObject({
      code: 'AI_UNAVAILABLE',
      retryable: true,
    });
  });
});

/* --------------------------------- helpers -------------------------------- */

interface Call {
  url: string;
  init: RequestInit;
}

function build(
  bytes: Buffer,
  options: { speechVoice?: string; speechModel?: string } = {},
  status = 200,
) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(status === 200 ? bytes : 'nope', { status });
  });

  const provider = new OpenAiProvider({
    apiKey: 'k',
    fetchImpl: fetchImpl as never,
    ...options,
  });

  return { provider, calls };
}

function body(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/** Ogg magic bytes and a little payload — enough to be non-empty and real. */
function audio(): Buffer {
  return Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0, 0, 0, 0, 0])]);
}
