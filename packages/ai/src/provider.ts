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
   *
   * **Optional, and the optionality is the honest part.** Anthropic publishes no
   * embeddings API, so an implementation that satisfied this method could only
   * throw — and a caller cannot tell "will always throw" from "might work"
   * without making the call, paying a round trip and a log line to learn
   * something knowable up front. Absent instead: `if (!provider.embed)` is a
   * branch both call sites already have, because both must already handle a
   * deployment with no provider configured at all.
   */
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /**
   * Text to speech.
   *
   * Optional for the same reason `embed` is, and the bar for implementing it is
   * higher than "the vendor has an endpoint": it has to return audio WhatsApp
   * will actually play. Anthropic publishes no speech API at all; Gemini's
   * returns raw 24 kHz PCM, which WhatsApp cannot play and which we have no
   * transcoder to convert. On both it is absent rather than present-and-broken,
   * so a caller that checks `canSpeak` once learns the truth without paying a
   * round trip and a log line to discover it.
   */
  speak?(request: SpeechRequest): Promise<SpeechResponse>;
}

/**
 * A provider that actually embeds.
 *
 * Narrowing `embed` from optional to present in one named place, so every caller
 * checks once and nothing downstream needs a non-null assertion on a method that
 * genuinely may not exist.
 */
export type EmbeddingProvider = AiProvider & {
  embed: NonNullable<AiProvider['embed']>;
};

/** Whether this provider can embed. The narrowing the callers branch on. */
export function canEmbed(provider: AiProvider | null | undefined): provider is EmbeddingProvider {
  return typeof provider?.embed === 'function';
}

/**
 * A provider that actually speaks.
 *
 * The same narrowing `EmbeddingProvider` performs, in one named place.
 */
export type SpeechProvider = AiProvider & {
  speak: NonNullable<AiProvider['speak']>;
};

/** Whether this provider can speak. The narrowing the callers branch on. */
export function canSpeak(provider: AiProvider | null | undefined): provider is SpeechProvider {
  return typeof provider?.speak === 'function';
}

export interface EmbeddingRequest {
  text: string;
  signal?: AbortSignal;
}

export interface SpeechRequest {
  /**
   * What will be spoken, verbatim.
   *
   * Already bounded and already stripped by `prepareSpeech`. A provider is not
   * the place to decide how much of someone's email is worth reading out.
   */
  text: string;
  /** Provider-specific voice id. Absent means the provider's default. */
  voice?: string;
  signal?: AbortSignal;
}

export interface SpeechResponse {
  audio: Buffer;
  /**
   * What the bytes actually are, carried rather than assumed.
   *
   * WhatsApp rejects an upload whose declared type does not match its content,
   * and it accepts Ogg only when the codec inside is Opus. So this has to come
   * from whatever encoded it, not from a constant at the send site that would
   * go stale the moment a provider changed its default format.
   */
  mimeType: string;
  usage: AiUsage;
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
