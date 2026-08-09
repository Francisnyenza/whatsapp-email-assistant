/** Public surface of @wea/ai. */

export {
  buildEnvelope,
  neutralize,
  containsInstructionLikeText,
  MAX_ENVELOPE_CHARS,
  type Envelope,
  type UntrustedBlock,
} from './envelope.js';

export { canEmbed } from './provider.js';

export type {
  AiProvider,
  EmbeddingProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
} from './provider.js';

export { analyzeEmail, extractJson, type AnalysisInput } from './analysis.js';

export { embedEmail, embedQuery, embeddableText } from './embedding.js';

export { translateEmail, type TranslationInput, type Translation } from './translate.js';

export { draftReply, type DraftInput } from './draft.js';

export { OpenAiProvider, type OpenAiOptions } from './providers/openai.js';
export { GeminiProvider, type GeminiOptions } from './providers/gemini.js';
export { AnthropicProvider, type AnthropicOptions } from './providers/anthropic.js';
