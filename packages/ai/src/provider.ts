import type { AiTaskClass, AiUsage } from '@wea/shared';

/**
 * The port every model provider implements.
 *
 * Deliberately narrow, and deliberately without tools. There is no function on
 * this interface that a model can call to send, delete, forward or move mail —
 * not because the current providers happen not to expose one, but because the
 * port has no shape for it (ADR 0004). Adding one would be a visible change to
 * this file and to the review that follows it.
 *
 * Everything returns text. Turning text into a validated structure is a
 * separate step, so an implementation cannot short-circuit the schema check by
 * returning something already typed.
 */
export interface AiProvider {
  /** For metering and for the model column on stored analyses. */
  readonly name: string;

  /**
   * One completion.
   *
   * @throws {AppError} with a retryable flag reflecting whether trying again
   *   could plausibly work — a rate limit can, a malformed request cannot.
   */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * One embedding.
   *
   * Separate from `complete` because it is a different endpoint, a different
   * model tier and a different price — and because an embedding is a vector,
   * not text, so folding it into the text path would mean parsing numbers back
   * out of a string.
   */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface EmbeddingRequest {
  text: string;
  signal?: AbortSignal;
}

export interface EmbeddingResponse {
  /** Unit-normalized by the provider; cosine distance is what the index uses. */
  vector: number[];
  usage: AiUsage;
}

export interface CompletionRequest {
  /** Ours, always. Never contains third-party content. */
  system: string;
  /** Carries the untrusted envelope. */
  user: string;
  /** Chooses the model tier and the budget it is charged against. */
  task: AiTaskClass;
  /**
   * Ask the provider for JSON. Honoured where supported and treated as a hint
   * everywhere else — the schema check afterwards is what actually guarantees
   * the shape.
   */
  json?: boolean;
  maxOutputTokens?: number;
  /** Zero for analysis: the same email should classify the same way twice. */
  temperature?: number;
  /** Abandons a call the user is no longer waiting for. */
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  usage: AiUsage;
}
