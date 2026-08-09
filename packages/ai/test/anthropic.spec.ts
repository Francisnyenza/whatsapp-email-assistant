import { describe, it, expect, vi } from 'vitest';
import { AppError } from '@wea/shared';
import { AnthropicProvider, canEmbed, extractJson } from '../src/index.js';

/**
 * The Anthropic adapter.
 *
 * The two things worth pinning here both come from the API being genuinely
 * different rather than superficially different. There is no JSON mode, so JSON
 * is obtained by prefilling the assistant's turn with `{` — which means the
 * opening brace is not echoed back and has to be put on again. And there are no
 * embeddings at all, so `embed` is *absent* rather than present-and-throwing.
 */

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

const status = (code: number) =>
  vi.fn().mockResolvedValue({ ok: false, status: code, json: async () => ({}) });

const provider = (fetchImpl: typeof fetch) => new AnthropicProvider({ apiKey: 'k', fetchImpl });

const replied = (text: string, stopReason = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  usage: { input_tokens: 100, output_tokens: 50 },
});

const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>) =>
  JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as Record<string, unknown>;

describe('getting JSON out of a model with no JSON mode', () => {
  it('prefills the assistant turn with an opening brace', async () => {
    // Starting the model's own message with `{` leaves it no way to open with
    // "Here's the analysis:" — that sentence would have to be inside an object.
    const fetchImpl = ok(replied('"summary": "hi"}'));

    await provider(fetchImpl as never).complete({
      system: 's',
      user: 'u',
      task: 'analysis',
      json: true,
    });

    const messages = bodyOf(fetchImpl).messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '{' },
    ]);
  });

  it('puts the brace back, so what comes out actually parses', async () => {
    // The prefill is not echoed. Forgetting this produces valid JSON minus its
    // opening brace, which parses as nothing and reads as a model failure.
    const result = await provider(ok(replied('"summary": "hi"}')) as never).complete({
      system: 's',
      user: 'u',
      task: 'analysis',
      json: true,
    });

    expect(result.text).toBe('{"summary": "hi"}');
    expect(extractJson(result.text)).toEqual({ summary: 'hi' });
  });

  it('does not prefill when the caller did not ask for JSON', async () => {
    const fetchImpl = ok(replied('Hello.'));

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'composition' });

    const messages = bodyOf(fetchImpl).messages as unknown[];
    expect(messages).toHaveLength(1);
  });

  it('does not put a brace on a response that was never prefilled', async () => {
    const result = await provider(ok(replied('Hello.')) as never).complete({
      system: 's',
      user: 'u',
      task: 'composition',
    });

    expect(result.text).toBe('Hello.');
  });
});

describe('completions', () => {
  it('sends the system prompt as its own field', async () => {
    const fetchImpl = ok(replied('hi'));

    await provider(fetchImpl as never).complete({ system: 'rules', user: 'u', task: 'analysis' });

    expect(bodyOf(fetchImpl).system).toBe('rules');
  });

  it('never sends a tools array', async () => {
    // ADR 0004, same as every other adapter.
    const fetchImpl = ok(replied('hi'));

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    expect(bodyOf(fetchImpl)).not.toHaveProperty('tools');
  });

  it('always sends max_tokens, which this API requires', async () => {
    const fetchImpl = ok(replied('hi'));

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    expect(bodyOf(fetchImpl).max_tokens).toBeGreaterThan(0);
  });

  it('pins the API version rather than floating', async () => {
    const fetchImpl = ok(replied('hi'));

    await provider(fetchImpl as never).complete({ system: 's', user: 'u', task: 'analysis' });

    const headers = (fetchImpl.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBe('k');
  });

  it('joins the text blocks and ignores anything else', async () => {
    const result = await provider(
      ok({
        content: [
          { type: 'thinking', thinking: 'ignored' },
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }) as never,
    ).complete({ system: 's', user: 'u', task: 'composition' });

    expect(result.text).toBe('part one part two');
  });

  it('rejects a truncated response rather than returning half an object', async () => {
    await provider(ok(replied('"summary": "hi', 'max_tokens')) as never)
      .complete({ system: 's', user: 'u', task: 'analysis', json: true })
      .catch((err: AppError) => {
        expect(err.code).toBe('AI_INVALID_OUTPUT');
        expect(err.retryable).toBe(true);
      });
    expect.assertions(2);
  });

  it('prices the call', async () => {
    const result = await provider(ok(replied('hi')) as never).complete({
      system: 's',
      user: 'u',
      task: 'analysis',
    });

    expect(result.usage.provider).toBe('anthropic');
    expect(result.usage.totalTokens).toBe(150);
    expect(result.usage.costMicros).toBeGreaterThan(0);
  });
});

describe('embeddings it does not have', () => {
  it('has no embed method at all', async () => {
    // Anthropic publishes no embeddings API. A method here could only throw,
    // and a caller cannot tell "will always throw" from "might work" without
    // paying for the call to find out.
    const instance = provider(ok(replied('hi')) as never);

    expect(instance.embed).toBeUndefined();
    expect(canEmbed(instance)).toBe(false);
  });
});

describe('which failures are worth retrying', () => {
  const call = (code: number) =>
    provider(status(code) as never).complete({ system: 's', user: 'u', task: 'analysis' });

  it.each([
    [429, true],
    // Anthropic's own "overloaded" status, which is transient by definition.
    [529, true],
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
