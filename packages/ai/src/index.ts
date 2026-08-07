/** Public surface of @wea/ai. */

export {
  buildEnvelope,
  neutralize,
  containsInstructionLikeText,
  MAX_ENVELOPE_CHARS,
  type Envelope,
  type UntrustedBlock,
} from './envelope.js';

export type { AiProvider, CompletionRequest, CompletionResponse } from './provider.js';

export { analyzeEmail, extractJson, type AnalysisInput } from './analysis.js';

export { OpenAiProvider, type OpenAiOptions } from './providers/openai.js';
