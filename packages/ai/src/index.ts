/** Public surface of @wea/ai. */

export {
  buildEnvelope,
  neutralize,
  containsInstructionLikeText,
  MAX_ENVELOPE_CHARS,
  type Envelope,
  type UntrustedBlock,
} from './envelope.js';

export { canEmbed, canSpeak, canTranscribe } from './provider.js';

export type {
  AiProvider,
  EmbeddingProvider,
  SpeechProvider,
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  SpeechRequest,
  TranscriptionRequest,
  TranscriptionResponse,
  TranscriptionProvider,
  SpeechResponse,
} from './provider.js';

export { analyzeEmail, extractJson, type AnalysisInput } from './analysis.js';

export { embedEmail, embedQuery, embeddableText } from './embedding.js';

export { translateEmail, type TranslationInput, type Translation } from './translate.js';

export { draftReply, type DraftInput } from './draft.js';

export { answerQuestion, type AskInput, type AskSource, type Answer } from './ask.js';

export {
  prepareSpeech,
  stripQuotedHistory,
  SPEECH_MAX_BODY_CHARS,
  type SpeechSource,
  type PreparedSpeech,
} from './speech.js';

export { OpenAiProvider, type OpenAiOptions } from './providers/openai.js';
export { GeminiProvider, type GeminiOptions } from './providers/gemini.js';
export { AnthropicProvider, type AnthropicOptions } from './providers/anthropic.js';
