import { AppError, type AiTaskClass, type AiUsage } from '@wea/shared';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../provider.js';

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
 * this meters spend for per-user reporting, and is not billing.
 *
 * One consequence is worth naming rather than discovering: a call costing less
 * than half a micro-USD meters as zero. A ten-token search query against
 * text-embedding-3-small costs 0.0002 micros and is recorded as nothing. That is
 * accepted, because the thing this protects — `AI_MAX_TOKENS_PER_USER_DAY` —
 * is enforced on token counts, which are recorded exactly. Cost is the number an
 * operator reads; tokens are the number that stops a runaway loop.
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
        signal: this.signalFor(request.signal),
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

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.models.embedding;
    const startedAt = Date.now();

    // Bounded before it is sent. The endpoint has a hard token limit and
    // rejects the whole request past it, so a long email would otherwise
    // produce an error rather than a slightly shorter vector.
    const input = request.text.slice(0, MAX_EMBEDDING_CHARS);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, input }),
        signal: this.signalFor(request.signal),
      });
    } catch (err) {
      throw new AppError('AI_UNAVAILABLE', 'Could not reach the model provider', {
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) throw mapHttpError(response.status);

    const body = (await response.json()) as OpenAiEmbeddingResponse;
    const vector = body.data?.[0]?.embedding;

    if (!Array.isArray(vector) || vector.length === 0) {
      throw new AppError('AI_INVALID_OUTPUT', 'Model returned no embedding', { retryable: true });
    }

    // Every element has to be a finite number: these are interpolated into a
    // pgvector literal, and a NaN or an Infinity would either be rejected by
    // Postgres or stored as something that silently never matches.
    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new AppError('AI_INVALID_OUTPUT', 'Embedding contained a non-finite value', {
        retryable: false,
      });
    }

    return { vector, usage: usageFrom(body, model, Date.now() - startedAt) };
  }

  /**
   * Our own timeout as well as the caller's: a request left hanging holds a
   * worker slot, and BullMQ's timeout would kill the job without recording what
   * happened.
   */
  private signalFor(caller?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }
}

/**
 * text-embedding-3-small accepts 8192 tokens. Characters are a coarse proxy,
 * deliberately conservative — an embedding of the first few thousand characters
 * is a good one, and a rejected request is no embedding at all.
 */
const MAX_EMBEDDING_CHARS = 20_000;

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
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

function usageFrom(
  body: OpenAiChatResponse | OpenAiEmbeddingResponse,
  model: string,
  latencyMs: number,
): AiUsage {
  const promptTokens = body.usage?.prompt_tokens ?? 0;
  const completionTokens =
    'completion_tokens' in (body.usage ?? {})
      ? ((body.usage as { completion_tokens?: number }).completion_tokens ?? 0)
      : 0;
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
