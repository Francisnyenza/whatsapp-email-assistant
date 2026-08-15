import { AppError, type AiTaskClass, type AiUsage } from '@wea/shared';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  SpeechRequest,
  SpeechResponse,
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
  /**
   * Deliberately not a member of `models`.
   *
   * `AiTaskClass` selects a *completion* model and is passed straight to
   * `complete()`. Speech is a different endpoint returning bytes rather than
   * text, so folding it into that record would oblige every provider — including
   * the two that cannot speak at all — to name a speech model.
   */
  speechModel?: string;
  speechVoice?: string;
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
   * Speech, as Ogg-encapsulated Opus.
   *
   * The format is not a preference. WhatsApp plays Ogg only when the codec
   * inside is Opus, and only an Opus voice note renders as a voice note rather
   * than as a file attachment the recipient has to decide to open. MP3 would
   * upload fine and arrive as something nobody plays.
   */
  async speak(request: SpeechRequest): Promise<SpeechResponse> {
    const model = this.speechModel;
    const startedAt = Date.now();

    // Bounded here as well as in `prepareSpeech`, because the two bounds answer
    // different questions: that one asks how much of an email is worth
    // listening to, this one asks what the endpoint will accept. A caller that
    // skips the first must still not be able to send a megabyte of text.
    const input = request.text.slice(0, MAX_SPEECH_CHARS);

    if (!input.trim()) {
      // Every provider bills for the attempt and returns silence. Silence is
      // also exactly what a failed read sounds like, so refusing here keeps the
      // two apart for the caller.
      throw new AppError('AI_INVALID_OUTPUT', 'Nothing to speak', { retryable: false });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input,
          voice: request.voice ?? this.options.speechVoice ?? 'alloy',
          response_format: 'opus',
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

    const audio = Buffer.from(await response.arrayBuffer());

    if (audio.length === 0) {
      throw new AppError('AI_INVALID_OUTPUT', 'Model returned no audio', { retryable: true });
    }

    return {
      audio,
      mimeType: 'audio/ogg',
      usage: speechUsage(input, model, Date.now() - startedAt),
    };
  }

  private get speechModel(): string {
    return this.options.speechModel ?? DEFAULT_SPEECH_MODEL;
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

const DEFAULT_SPEECH_MODEL = 'gpt-4o-mini-tts';

/**
 * The endpoint's own ceiling is 4096 characters and it rejects the whole
 * request past it — so a long email would produce an error rather than a
 * slightly shorter voice note. `prepareSpeech` bounds far below this for
 * reasons about listening rather than about the API.
 */
const MAX_SPEECH_CHARS = 4_000;

/** USD micro-units per million characters of input, as published. */
const SPEECH_PRICING: Record<string, number> = {
  'gpt-4o-mini-tts': 12_000_000,
  'tts-1': 15_000_000,
  'tts-1-hd': 30_000_000,
};

/**
 * What a speech call cost, estimated.
 *
 * The speech endpoint returns audio bytes and no usage object — there is no
 * token count to read, so unlike every other call in this file these numbers
 * are derived rather than reported. Characters are converted at the
 * conventional four-per-token, which is a rough ratio and wrong in both
 * directions for CJK and for code.
 *
 * Recorded as tokens anyway, and that is the deliberate part. The daily ceiling
 * is enforced on `totalTokens`; leaving speech out of it entirely would make
 * repeated "read that aloud" the one request in the product with no ceiling at
 * all, which is precisely the runaway that ceiling exists to catch. An
 * approximate charge against the budget is closer to right than none.
 *
 * `costMicros`, by contrast, is exact: the endpoint prices per character, and
 * characters are counted, not estimated.
 */
function speechUsage(input: string, model: string, latencyMs: number): AiUsage {
  const characters = input.length;
  const estimatedTokens = Math.ceil(characters / 4);
  const perMillion = SPEECH_PRICING[model] ?? 0;

  return {
    promptTokens: estimatedTokens,
    completionTokens: 0,
    totalTokens: estimatedTokens,
    model,
    provider: 'openai',
    latencyMs,
    costMicros: Math.round((characters * perMillion) / 1_000_000),
  };
}

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
