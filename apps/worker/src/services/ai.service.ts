import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError } from '@wea/shared';
import { OpenAiProvider, GeminiProvider, AnthropicProvider, type AiProvider } from '@wea/ai';
import { ConfigService } from '../config/config.service.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';

/**
 * Choosing a model provider, and deciding whether we can afford to call it.
 *
 * Both answers are allowed to be "no". A deployment with no API key is an
 * ordinary configuration, not a broken one — the product delivers mail to
 * WhatsApp, and the summaries make it nicer. Every caller here treats an absent
 * provider the same way it treats a failed one: carry on without.
 *
 * What is *not* allowed is a configured provider that quietly does nothing.
 * `AI_PRIMARY_PROVIDER` accepted `gemini` and `anthropic` while only OpenAI was
 * built, so selecting either passed validation, passed boot, and disabled
 * summaries for every email — a setting that reads as "on" and behaves as "off".
 * A provider named in the environment either resolves to an implementation or
 * refuses to start.
 */
@Injectable()
export class AiService {
  private readonly primary: AiProvider | null;
  private readonly fallback: AiProvider | null;

  constructor(
    private readonly config: ConfigService,
    private readonly analyses: AnalysisRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    this.primary =
      this.config.env.AI_PRIMARY_PROVIDER === 'none'
        ? null
        : this.build(this.config.env.AI_PRIMARY_PROVIDER);
    this.fallback =
      this.config.env.AI_FALLBACK_PROVIDER === 'none'
        ? null
        : this.build(this.config.env.AI_FALLBACK_PROVIDER);

    if (!this.primary) {
      this.logger.info(
        { event: 'ai.not_configured', provider: this.config.env.AI_PRIMARY_PROVIDER },
        'No model provider configured; notifications will ship without summaries',
      );
    } else {
      this.logger.info(
        {
          event: 'ai.configured',
          provider: this.primary.name,
          fallback: this.fallback?.name ?? null,
          // Worth its own field: with this false, search runs on keyword and
          // trigram only, and nobody should have to infer that from a provider
          // name.
          embeddings: typeof this.primary.embed === 'function',
        },
        'Model provider ready',
      );
    }
  }

  /** Null when no provider is configured. Callers degrade rather than fail. */
  provider(): AiProvider | null {
    return this.primary;
  }

  /**
   * The provider to try after the primary failed, or null.
   *
   * Deliberately a second *call*, not an automatic retry inside `provider()`.
   * The caller knows whether a second attempt is worth making — the analysis
   * processor has a notification waiting on it and one retry is worth ~200ms,
   * while a search that already has keyword results has nothing to gain from
   * one — and hiding a failover inside the accessor would take that judgement
   * away from both of them.
   */
  secondary(): AiProvider | null {
    return this.fallback;
  }

  /**
   * Whether this user has spent their daily token allowance.
   *
   * Checked before the call rather than after, because after is a bill. The
   * check is a single aggregate against an indexed `(user_id, day)`, and a
   * ceiling of zero means unlimited — which is the sane reading of "not
   * configured" for a self-hosted deployment.
   */
  async isOverBudget(userId: string): Promise<boolean> {
    const ceiling = this.config.env.AI_MAX_TOKENS_PER_USER_DAY;
    if (!ceiling) return false;

    try {
      return (await this.analyses.tokensUsedToday(userId)) >= ceiling;
    } catch (err) {
      // Failing open is deliberate. A database hiccup should not stop mail
      // being summarised, and the ceiling is a cost control rather than a
      // security boundary — the blast radius of getting this wrong is one
      // user's tokens for one day.
      this.logger.warn(
        { event: 'ai.budget_check_failed', userId, err },
        'Could not read the token budget; proceeding',
      );
      return false;
    }
  }

  /**
   * Builds one provider by name.
   *
   * An absent key returns null — that is the "no AI configured" deployment, and
   * the env schema already refuses to boot when a *selected* provider has no
   * key, so reaching this with a missing key means the provider was not really
   * selected. An unrecognised name throws, because the alternative is the exact
   * bug this class was rewritten to remove.
   */
  private build(name: 'openai' | 'gemini' | 'anthropic'): AiProvider | null {
    const env = this.config.env;
    const timeoutMs = env.AI_REQUEST_TIMEOUT_MS;

    switch (name) {
      case 'openai':
        return env.OPENAI_API_KEY
          ? new OpenAiProvider({
              apiKey: env.OPENAI_API_KEY,
              timeoutMs,
              models: {
                analysis: env.OPENAI_MODEL_FAST,
                classification: env.OPENAI_MODEL_FAST,
                composition: env.OPENAI_MODEL_SMART,
                embedding: env.OPENAI_MODEL_EMBEDDING,
              },
            })
          : null;

      case 'gemini':
        return env.GEMINI_API_KEY
          ? new GeminiProvider({
              apiKey: env.GEMINI_API_KEY,
              timeoutMs,
              models: {
                analysis: env.GEMINI_MODEL_FAST,
                classification: env.GEMINI_MODEL_FAST,
                composition: env.GEMINI_MODEL_SMART,
              },
            })
          : null;

      case 'anthropic':
        return env.ANTHROPIC_API_KEY
          ? new AnthropicProvider({
              apiKey: env.ANTHROPIC_API_KEY,
              timeoutMs,
              models: {
                analysis: env.ANTHROPIC_MODEL_FAST,
                classification: env.ANTHROPIC_MODEL_FAST,
                composition: env.ANTHROPIC_MODEL_SMART,
              },
            })
          : null;

      default:
        // Unreachable through the env schema, which is an enum. Reachable if
        // someone widens that enum and forgets this switch, which is precisely
        // how the silent-no-op version of this class came to exist.
        throw new AppError('INTERNAL', `No implementation for AI provider "${String(name)}"`, {
          retryable: false,
        });
    }
  }
}
