import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@wea/shared';
import { OpenAiProvider } from '../src/index.js';

/**
 * The OpenAI adapter.
 *
 * Two things are worth pinning down here. First, which failures are retryable:
 * getting that wrong either burns a rate limit on a key that will never work, or
 * gives up on an outage that would have cleared in ten seconds. Second, what the
 * adapter refuses to hand back — an embedding reaches a typed Postgres column,
 * and a `NaN` in it is stored as something that silently never matches any
 * search, which is the kind of bug nobody reports because it looks like "search
 * just isn't very good".
 */

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

const status = (code: number) =>
  vi.fn().mockResolvedValue({ ok: false, status: code, json: async () => ({}) });

const vector = Array.from({ length: 1536 }, () => 0.1);

const provider = (fetchImpl: typeof fetch) => new OpenAiProvider({ apiKey: 'sk-test', fetchImpl });

const embeddingBody = (v: unknown = vector, tokens = 8) => ({
  data: [{ embedding: v }],
  usage: { prompt_tokens: tokens, total_tokens: tokens },
});

describe('embeddings', () => {
  it('returns the vector and prices the call', async () => {
    const body = embeddingBody(vector, 500_000);
    const result = await provider(ok(body) as never).embed({ text: 'invoice' });

    expect(result.vector).toHaveLength(1536);
    expect(result.usage.model).toBe('text-embedding-3-small');
    expect(result.usage.promptTokens).toBe(500_000);
    // 500k tokens at $0.02/M.
    expect(result.usage.costMicros).toBe(10_000);
  });

  it('meters a sub-micro call as zero, which is why the budget rides on tokens', async () => {
    // A ten-token search query costs 0.0002 micro-USD. Recording it as zero is
    // accepted; recording its tokens as zero would not be, because
    // AI_MAX_TOKENS_PER_USER_DAY is what actually stops a runaway loop.
    const result = await provider(ok(embeddingBody(vector, 10)) as never).embed({ text: 'x' });

    expect(result.usage.costMicros).toBe(0);
    expect(result.usage.totalTokens).toBe(10);
  });

  it('bounds the input before sending it', async () => {
    // The endpoint rejects the whole request past its token limit, so a long
    // email would otherwise produce an error rather than a shorter vector.
    const fetchImpl = ok(embeddingBody());

    await provider(fetchImpl as never).embed({ text: 'x'.repeat(100_000) });

    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      input: string;
    };
    expect(sent.input.length).toBe(20_000);
  });

  it('refuses a vector containing a non-finite value', async () => {
    // These are interpolated into a pgvector literal. A NaN is either rejected
    // by Postgres or stored as something that never matches.
    const bad = [...vector];
    bad[3] = Number.NaN;

    await expect(provider(ok(embeddingBody(bad)) as never).embed({ text: 'x' })).rejects.toThrow(
      /non-finite/,
    );
  });

  it('refuses a vector that is not numbers at all', async () => {
    const bad = [...vector] as unknown[];
    bad[3] = '0.1';

    await expect(
      provider(ok(embeddingBody(bad)) as never).embed({ text: 'x' }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('refuses an empty response rather than storing a zero-length vector', async () => {
    await expect(provider(ok({ data: [] }) as never).embed({ text: 'x' })).rejects.toThrow(
      /no embedding/,
    );
  });

  it('does not mark a malformed vector retryable — it will be just as malformed next time', async () => {
    const bad = [...vector];
    bad[3] = Number.POSITIVE_INFINITY;

    await provider(ok(embeddingBody(bad)) as never)
      .embed({ text: 'x' })
      .catch((err: AppError) => {
        expect(err.retryable).toBe(false);
      });
    expect.assertions(1);
  });
});

describe('which failures are worth retrying', () => {
  const embedWith = (code: number) => provider(status(code) as never).embed({ text: 'x' });

  it('retries a rate limit', async () => {
    await embedWith(429).catch((err: AppError) => expect(err.retryable).toBe(true));
    expect.assertions(1);
  });

  it('retries a server error', async () => {
    await embedWith(503).catch((err: AppError) => expect(err.retryable).toBe(true));
    expect.assertions(1);
  });

  it('does not retry a rejected key, which no amount of retrying fixes', async () => {
    await embedWith(401).catch((err: AppError) => expect(err.retryable).toBe(false));
    expect.assertions(1);
  });

  it('does not retry a malformed request', async () => {
    await embedWith(400).catch((err: AppError) => expect(err.retryable).toBe(false));
    expect.assertions(1);
  });

  it('treats an unreachable provider as retryable — the request may not have arrived', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    await provider(fetchImpl as never)
      .embed({ text: 'x' })
      .catch((err: AppError) => expect(err.retryable).toBe(true));
    expect.assertions(1);
  });
});

describe('the completion path', () => {
  it('never sends a tools array, because the port has no shape for one', async () => {
    // ADR 0004. A model cannot authorize an action here, and the absence is
    // structural rather than incidental.
    const fetchImpl = ok({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('functions');
    expect(sent).not.toHaveProperty('tool_choice');
  });

  it('defaults analysis to a temperature of zero, so the same email classifies the same way', async () => {
    const fetchImpl = ok({
      choices: [{ message: { content: '{}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    const sent = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      temperature: number;
    };
    expect(sent.temperature).toBe(0);
  });
});
