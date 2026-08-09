import { AppError, type AiTaskClass, type AiUsage } from '@wea/shared';
import type { AiProvider, CompletionRequest, CompletionResponse } from '../provider.js';

/**
 * Anthropic's Messages API.
 *
 * No `embed` method, deliberately: Anthropic publishes no embeddings API, so a
 * method here could only throw. The port makes `embed` optional for exactly this
 * reason — the callers branch on its absence and skip the semantic arm, which is
 * the same path a deployment with no provider at all already takes. Selecting
 * Anthropic therefore gives full analysis and keyword-only search, and says so
 * once at boot rather than failing per query.
 *
 * As everywhere else, no `tools` array is ever sent (ADR 0004).
 */

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  models?: Partial<Record<AiTaskClass, string>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODELS: Record<AiTaskClass, string> = {
  analysis: 'claude-haiku-4-5-20251001',
  classification: 'claude-haiku-4-5-20251001',
  composition: 'claude-sonnet-5',
  // Present because the type demands a value for every task class, and never
  // reached: there is no `embed` on this provider.
  embedding: 'none',
};

/** USD micro-units per million tokens. Reporting, not billing. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 1_000_000, output: 5_000_000 },
  'claude-sonnet-5': { input: 3_000_000, output: 15_000_000 },
};

/**
 * The Messages API requires `max_tokens`, unlike the other two, so a caller that
 * did not specify one still needs a number. Generous enough for the analysis
 * shape and far below anything that would surprise on a bill.
 */
const DEFAULT_MAX_TOKENS = 2_048;

/** Pinned rather than floating: a new version can change response shapes. */
const API_VERSION = '2023-06-01';

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  private readonly baseUrl: string;
  private readonly models: Record<AiTaskClass, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = this.models[request.task];
    const startedAt = Date.now();

    // There is no JSON mode. What there is instead is a prefilled assistant
    // turn: starting the model's own message with `{` leaves it no way to open
    // with "Here's the analysis:" — the sentence would have to be inside a JSON
    // object. More reliable than asking, and the schema check afterwards is
    // still what decides whether the result is usable.
    const messages: AnthropicMessage[] = [{ role: 'user', content: request.user }];
    if (request.json) messages.push({ role: 'assistant', content: '{' });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.options.apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: request.system,
          messages,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
          temperature: request.temperature ?? 0,
        }),
        signal: this.signalFor(request.signal),
      });
    } catch (err) {
      throw new AppError('AI_UNAVAILABLE', 'Could not reach the model provider', {
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) throw mapHttpError(response.status);

    const body = (await response.json()) as AnthropicMessageResponse;

    // Content is a list of blocks; only the text ones are ours to read.
    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();

    if (!text) {
      throw new AppError('AI_INVALID_OUTPUT', 'Model returned no content', { retryable: true });
    }

    // The prefill is not echoed back, so the `{` that made this JSON has to be
    // put back on. Forgetting it produces a response that is valid JSON minus
    // its opening brace — which parses as nothing and looks like a model
    // failure rather than ours.
    const restored = request.json ? `{${text}` : text;

    if (body.stop_reason === 'max_tokens') {
      // Truncated output is not partial output. A half-written JSON object
      // would be discarded by the schema check anyway; failing here says why.
      throw new AppError('AI_INVALID_OUTPUT', 'Model output was truncated', { retryable: true });
    }

    return { text: restored, usage: this.usageFrom(body.usage, model, Date.now() - startedAt) };
  }

  private signalFor(caller?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return caller ? AbortSignal.any([caller, timeout]) : timeout;
  }

  private usageFrom(usage: AnthropicUsage | undefined, model: string, latencyMs: number): AiUsage {
    const promptTokens = usage?.input_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;
    const price = PRICING[model] ?? { input: 0, output: 0 };

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model,
      provider: this.name,
      latencyMs,
      costMicros: Math.round(
        (promptTokens * price.input + completionTokens * price.output) / 1_000_000,
      ),
    };
  }
}

/** Same reasoning as the other two adapters. 529 is Anthropic's "overloaded". */
function mapHttpError(status: number): AppError {
  if (status === 429 || status === 529) {
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

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: AnthropicUsage;
}
