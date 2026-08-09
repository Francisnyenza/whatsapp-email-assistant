import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@wea/shared';
import { GeminiProvider } from '../src/index.js';

/**
 * The Gemini adapter.
 *
 * Three things here are not shared with the OpenAI adapter and each is a way to
 * get it quietly wrong: a blocked response arrives as a **200** with no text, a
 * long answer is split across **several parts** that must be joined, and the
 * embedding dimension is a **request parameter** rather than a property of the
 * model — which is the only reason this provider can write into a `vector(1536)`
 * column at all.
 */

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

const status = (code: number) =>
  vi.fn().mockResolvedValue({ ok: false, status: code, json: async () => ({}) });

const provider = (fetchImpl: typeof fetch) => new GeminiProvider({ apiKey: 'k', fetchImpl });

const generated = (parts: string[], finishReason = 'STOP') => ({
  candidates: [{ content: { parts: parts.map((text) => ({ text })) }, finishReason }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
});

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((fetchImpl.mock.calls[call]![1] as { body: string }).body) as Record<string, unknown>;

const headersOf = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) =>
  (fetchImpl.mock.calls[call]![1] as { headers: Record<string, string> }).headers;

describe('completions', () => {
  it('sends the system prompt as its own field, separate from the user turn', async () => {
    // Ours is structurally separate from the envelope carrying untrusted
    // content, which is a better shape than a message with a role.
    const fetchImpl = ok(generated(['{}']));

    await provider(fetchImpl as never).complete({
      system: 'rules',
      user: 'data',
      task: 'analysis',
    });

    const sent = bodyOf(fetchImpl) as {
      systemInstruction: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(sent.systemInstruction.parts[0]!.text).toBe('rules');
    expect(sent.contents[0]!.parts[0]!.text).toBe('data');
  });

  it('never sends a tools array, because the port has no shape for one', async () => {
    // ADR 0004. generateContent accepts one; this adapter does not send one.
    const fetchImpl = ok(generated(['{}']));

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    expect(bodyOf(fetchImpl)).not.toHaveProperty('tools');
  });

  it('joins a response split across parts', async () => {
    // Taking only the first part silently truncates the JSON, which then fails
    // the schema check and looks like a bad model rather than a bad adapter.
    const fetchImpl = ok(generated(['{"summ', 'ary": "hi"}']));

    const result = await provider(fetchImpl as never).complete({
      system: 's',
      user: 'u',
      task: 'analysis',
    });

    expect(result.text).toBe('{"summary": "hi"}');
  });

  it('asks for JSON when the caller wants JSON', async () => {
    const fetchImpl = ok(generated(['{}']));

    await provider(fetchImpl as never).complete({
      system: 's',
      user: 'u',
      task: 'analysis',
      json: true,
    });

    const sent = bodyOf(fetchImpl) as { generationConfig: { responseMimeType?: string } };
    expect(sent.generationConfig.responseMimeType).toBe('application/json');
  });

  it('treats a safety block as invalid output, not as success', async () => {
    // It arrives as a 200 with no text. Left alone it becomes an empty analysis.
    const fetchImpl = ok({ candidates: [{ finishReason: 'SAFETY' }] });

    await provider(fetchImpl as never)
      .complete({ system: 's', user: 'u', task: 'analysis' })
      .catch((err: AppError) => {
        expect(err.code).toBe('AI_INVALID_OUTPUT');
        // A second identical request gets blocked identically.
        expect(err.retryable).toBe(false);
      });
    expect.assertions(2);
  });

  it('treats truncation as retryable, because a shorter email would fit', async () => {
    const fetchImpl = ok(generated(['{"partial'], 'MAX_TOKENS'));

    await provider(fetchImpl as never)
      .complete({ system: 's', user: 'u', task: 'analysis' })
      .catch((err: AppError) => expect(err.retryable).toBe(true));
    expect.assertions(1);
  });

  it('prices the call from the reported token counts', async () => {
    const result = await provider(ok(generated(['{}'])) as never).complete({
      system: 's',
      user: 'u',
      task: 'analysis',
    });

    expect(result.usage.provider).toBe('gemini');
    expect(result.usage.totalTokens).toBe(150);
    expect(result.usage.costMicros).toBeGreaterThan(0);
  });
});

describe('embeddings', () => {
  const vector = Array.from({ length: 1536 }, () => 0.1);
  const embedded = (v: unknown = vector) => ({ embedding: { values: v } });

  it('asks for the dimension the column declares', async () => {
    // gemini-embedding-001 is natively 3072. Without this parameter every write
    // is a dimension error on a background job nobody is watching.
    const fetchImpl = ok(embedded());

    await provider(fetchImpl as never).embed({ text: 'invoice' });

    expect(bodyOf(fetchImpl).outputDimensionality).toBe(1536);
    expect(fetchImpl.mock.calls[0]![0]).toContain('gemini-embedding-001');
  });

  it('returns the vector', async () => {
    const result = await provider(ok(embedded()) as never).embed({ text: 'invoice' });
    expect(result.vector).toHaveLength(1536);
  });

  it('refuses a non-finite value', async () => {
    const bad = [...vector];
    bad[3] = Number.NaN;

    await expect(provider(ok(embedded(bad)) as never).embed({ text: 'x' })).rejects.toThrow(
      /non-finite/,
    );
  });

  it('refuses an empty response', async () => {
    await expect(provider(ok({ embedding: {} }) as never).embed({ text: 'x' })).rejects.toThrow(
      /no embedding/,
    );
  });

  it('bounds the input before sending it', async () => {
    const fetchImpl = ok(embedded());

    await provider(fetchImpl as never).embed({ text: 'x'.repeat(100_000) });

    const sent = bodyOf(fetchImpl) as { content: { parts: Array<{ text: string }> } };
    expect(sent.content.parts[0]!.text.length).toBe(20_000);
  });

  it('estimates usage rather than reporting zero, since the endpoint returns none', async () => {
    const result = await provider(ok(embedded()) as never).embed({ text: 'x'.repeat(400) });
    expect(result.usage.promptTokens).toBe(100);
  });
});

describe('credentials', () => {
  it('sends the key in a header, never in the URL', async () => {
    // A URL is the single most likely thing to reach an access log, an error
    // report or a trace span. Google's own examples use `?key=`.
    const fetchImpl = ok(generated(['{}']));

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    expect(headersOf(fetchImpl)['x-goog-api-key']).toBe('k');
    expect(fetchImpl.mock.calls[0]![0]).not.toContain('k');
  });
});

describe('which failures are worth retrying', () => {
  const call = (code: number) =>
    provider(status(code) as never).complete({ system: 's', user: 'u', task: 'analysis' });

  it.each([
    [429, true],
    [503, true],
    [401, false],
    [400, false],
  ])('%i → retryable %s', async (code, retryable) => {
    await call(code).catch((err: AppError) => expect(err.retryable).toBe(retryable));
    expect.assertions(1);
  });

  it('treats an unreachable provider as retryable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await provider(fetchImpl as never)
      .complete({ system: 's', user: 'u', task: 'analysis' })
      .catch((err: AppError) => expect(err.retryable).toBe(true));
    expect.assertions(1);
  });
});
