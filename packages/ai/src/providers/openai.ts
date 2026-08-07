import { AppError, type AiTaskClass, type AiUsage } from '@wea/shared';
import type { AiProvider, CompletionRequest, CompletionResponse } from '../provider.js';

/**
 * OpenAI's chat completions API.
 *
 * Notably absent: any use of tools or function calling. The port has no shape
 * for it and this implementation adds none (ADR 0004) — the model returns text,
 * and text is validated before anything else looks at it.
 */

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  /** Per task class, so analysis can run on a cheaper model than composition. */
  models?: Partial<Record<AiTaskClass, string>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODELS: Record<AiTaskClass, string> = {
  analysis: 'gpt-4o-mini',
  classification: 'gpt-4o-mini',
  composition: 'gpt-4o',
  embedding: 'text-embedding-3-small',
};

/**
 * USD micro-units per million tokens, as published. Approximate by nature —
 * this meters spend for budgets and per-user reporting, and is not billing.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 150_000, output: 600_000 },
  'gpt-4o': { input: 2_500_000, output: 10_000_000 },
  'text-embedding-3-small': { input: 20_000, output: 0 },
};

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';

  private readonly baseUrl: string;
  private readonly models: Record<AiTaskClass, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = this.models[request.task];
    const startedAt = Date.now();

    // Our own timeout as well as the caller's: a request left hanging holds a
    // worker slot, and BullMQ's own timeout would kill the job without ever
    // recording what happened.
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          temperature: request.temperature ?? 0,
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal,
      });
    } catch (err) {
      // A timeout or a dropped connection. Retryable: the request may simply
      // not have arrived.
      throw new AppError('AI_UNAVAILABLE', 'Could not reach the model provider', {
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) throw mapHttpError(response.status);

    const body = (await response.json()) as OpenAiChatResponse;
    const text = body.choices?.[0]?.message?.content;

    if (typeof text !== 'string' || !text) {
      throw new AppError('AI_INVALID_OUTPUT', 'Model returned no content', { retryable: true });
    }

    return { text, usage: usageFrom(body, model, Date.now() - startedAt) };
  }
}

/**
 * Which failures are worth retrying.
 *
 * 429 and 5xx are transient; 400 and 422 mean the request itself is wrong and
 * will be exactly as wrong on the fourth attempt. 401 is a configuration
 * problem that no amount of retrying fixes, and retrying it just burns the
 * rate limit on a key that does not work.
 */
function mapHttpError(status: number): AppError {
  if (status === 429) {
    return new AppError('AI_UNAVAILABLE', 'Model provider rate limit', { retryable: true });
  }
  if (status >= 500) {
    return new AppError('AI_UNAVAILABLE', 'Model provider is unavailable', { retryable: true });
  }
  if (status === 401 || status === 403) {
    return new AppError('AI_UNAVAILABLE', 'Model provider rejected our credentials', {
      retryable: false,
    });
  }
  return new AppError('AI_INVALID_OUTPUT', `Model provider refused the request (${status})`, {
    retryable: false,
  });
}

function usageFrom(body: OpenAiChatResponse, model: string, latencyMs: number): AiUsage {
  const promptTokens = body.usage?.prompt_tokens ?? 0;
  const completionTokens = body.usage?.completion_tokens ?? 0;
  const price = PRICING[model] ?? { input: 0, output: 0 };

  return {
    promptTokens,
    completionTokens,
    totalTokens: body.usage?.total_tokens ?? promptTokens + completionTokens,
    model,
    provider: 'openai',
    latencyMs,
    costMicros: Math.round(
      (promptTokens * price.input + completionTokens * price.output) / 1_000_000,
    ),
  };
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
