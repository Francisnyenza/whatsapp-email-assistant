import { AppError, type AiTaskClass, type AiUsage } from '@wea/shared';
import type {
  AiProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from '../provider.js';

/**
 * Google's Generative Language API.
 *
 * Same port, same absence of tools: `generateContent` accepts a `tools` array
 * and this implementation never sends one (ADR 0004). The model returns text and
 * the text is schema-checked before anything looks at it.
 *
 * Two differences from OpenAI are worth knowing about rather than discovering.
 * The system prompt is its own top-level field (`systemInstruction`) rather than
 * a message with a role, which is if anything a better shape for us — ours is
 * structurally separate from the envelope carrying untrusted content. And the
 * embedding dimension is a request parameter, not a property of the model, which
 * is what makes this provider usable at all against a `vector(1536)` column.
 */

export interface GeminiOptions {
  apiKey: string;
  baseUrl?: string;
  models?: Partial<Record<AiTaskClass, string>>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODELS: Record<AiTaskClass, string> = {
  analysis: 'gemini-2.0-flash',
  classification: 'gemini-2.0-flash',
  composition: 'gemini-2.0-pro',
  // Not text-embedding-004, which is 768-dimensional and cannot be widened.
  // gemini-embedding-001 defaults to 3072 and accepts an explicit
  // `outputDimensionality`, which is the only way a Gemini deployment can write
  // into the column the schema already declares.
  embedding: 'gemini-embedding-001',
};

/**
 * USD micro-units per million tokens, as published for the paid tier. Same
 * caveat as every other provider here: this is reporting, not billing, and a
 * call costing less than half a micro-USD meters as zero.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 100_000, output: 400_000 },
  'gemini-2.0-pro': { input: 1_250_000, output: 5_000_000 },
  'gemini-embedding-001': { input: 150_000, output: 0 },
};

/**
 * The dimension we ask for, matching `message_embeddings.embedding`.
 *
 * Truncating a Gemini embedding below its native 3072 is supported and
 * documented, and cosine distance is scale-invariant, so pgvector's
 * `vector_cosine_ops` does not care that the truncated vector is no longer unit
 * length. What does matter is that this number and the column must agree — a
 * mismatch is a write-time dimension error on a background job.
 */
const EMBEDDING_DIMENSIONS = 1536;

/** Gemini's own input ceiling is generous; ours is the same conservative bound. */
const MAX_EMBEDDING_CHARS = 20_000;

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';

  private readonly baseUrl: string;
  private readonly models: Record<AiTaskClass, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GeminiOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );
    this.models = { ...DEFAULT_MODELS, ...options.models };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = this.models[request.task];
    const startedAt = Date.now();

    const body = await this.post<GeminiGenerateResponse>(
      `/models/${encodeURIComponent(model)}:generateContent`,
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature ?? 0,
          ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
        },
      },
      request.signal,
    );

    const candidate = body.candidates?.[0];

    // A blocked response comes back as a 200 with no text and a reason, which is
    // a success as far as `fetch` is concerned. Treated as invalid output rather
    // than silently becoming an empty analysis.
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      throw new AppError('AI_INVALID_OUTPUT', `Model stopped early (${candidate.finishReason})`, {
        // MAX_TOKENS could go either way; SAFETY will not change on a retry.
        retryable: candidate.finishReason === 'MAX_TOKENS',
      });
    }

    // Gemini splits a response across parts more often than OpenAI does, and
    // taking only the first silently truncates the JSON.
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      throw new AppError('AI_INVALID_OUTPUT', 'Model returned no content', { retryable: true });
    }

    return { text, usage: this.usageFrom(body.usageMetadata, model, Date.now() - startedAt) };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const model = this.models.embedding;
    const startedAt = Date.now();
    const input = request.text.slice(0, MAX_EMBEDDING_CHARS);

    const body = await this.post<GeminiEmbedResponse>(
      `/models/${encodeURIComponent(model)}:embedContent`,
      {
        content: { parts: [{ text: input }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
        // Asymmetric embeddings: a stored document and a search query are
        // embedded for different purposes and Gemini exposes that. We do not
        // use it — one space, one task type — because a query embedded as
        // RETRIEVAL_QUERY and a document embedded as RETRIEVAL_DOCUMENT are
        // only comparable if every write ever made used the matching pair, and
        // that is a migration hazard for a ranking improvement we have not
        // measured.
        taskType: 'SEMANTIC_SIMILARITY',
      },
      request.signal,
    );

    const vector = body.embedding?.values;

    if (!Array.isArray(vector) || vector.length === 0) {
      throw new AppError('AI_INVALID_OUTPUT', 'Model returned no embedding', { retryable: true });
    }

    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new AppError('AI_INVALID_OUTPUT', 'Embedding contained a non-finite value', {
        retryable: false,
      });
    }

    // Gemini bills embeddings on input tokens and does not return a count here,
    // so the estimate is characters over four. Wrong in the third decimal place
    // and right about the order of magnitude, which is what this number is for.
    const promptTokens = Math.ceil(input.length / 4);

    return {
      vector,
      usage: this.usageFrom(
        { promptTokenCount: promptTokens, totalTokenCount: promptTokens },
        model,
        Date.now() - startedAt,
      ),
    };
  }

  /**
   * One request.
   *
   * The key goes in a header rather than the `?key=` query parameter Google's
   * examples use. A URL is the single most likely thing to end up in an access
   * log, an error report or a trace span, and a credential there is a
   * credential leaked to everything downstream that records a URL.
   */
  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'x-goog-api-key': this.options.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: signalFor(this.timeoutMs, signal),
      });
    } catch (err) {
      throw new AppError('AI_UNAVAILABLE', 'Could not reach the model provider', {
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) throw mapHttpError(response.status);

    return (await response.json()) as T;
  }

  private usageFrom(metadata: GeminiUsage | undefined, model: string, latencyMs: number): AiUsage {
    const promptTokens = metadata?.promptTokenCount ?? 0;
    const completionTokens = metadata?.candidatesTokenCount ?? 0;
    const price = PRICING[model] ?? { input: 0, output: 0 };

    return {
      promptTokens,
      completionTokens,
      totalTokens: metadata?.totalTokenCount ?? promptTokens + completionTokens,
      model,
      provider: this.name,
      latencyMs,
      costMicros: Math.round(
        (promptTokens * price.input + completionTokens * price.output) / 1_000_000,
      ),
    };
  }
}

/**
 * Which failures are worth retrying. Identical reasoning to the OpenAI adapter:
 * 429 and 5xx are transient, 400 will be exactly as wrong next time, and 401/403
 * is a configuration problem that retrying only burns quota on.
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

/**
 * Our own timeout as well as the caller's: a request left hanging holds a worker
 * slot, and BullMQ's timeout would kill the job without recording what happened.
 */
function signalFor(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsage;
}

interface GeminiEmbedResponse {
  embedding?: { values?: number[] };
}
