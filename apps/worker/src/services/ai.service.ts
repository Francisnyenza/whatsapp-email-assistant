import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { OpenAiProvider, type AiProvider } from '@wea/ai';
import { ConfigService } from '../config/config.service.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';

/**
 * Choosing a model provider, and deciding whether we can afford to call it.
 *
 * Both answers are allowed to be "no". A deployment with no API key is an
 * ordinary configuration, not a broken one — the product delivers mail to
 * WhatsApp, and the summaries make it nicer. Every caller here treats an absent
 * provider the same way it treats a failed one: carry on without.
 */
@Injectable()
export class AiService {
  private readonly configured: AiProvider | null;

  constructor(
    private readonly config: ConfigService,
    private readonly analyses: AnalysisRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    this.configured = this.build();
  }

  /** Null when no provider is configured. Callers degrade rather than fail. */
  provider(): AiProvider | null {
    return this.configured;
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

  private build(): AiProvider | null {
    const env = this.config.env;

    if (env.AI_PRIMARY_PROVIDER === 'openai' && env.OPENAI_API_KEY) {
      return new OpenAiProvider({
        apiKey: env.OPENAI_API_KEY,
        timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
        models: {
          analysis: env.OPENAI_MODEL_FAST,
          classification: env.OPENAI_MODEL_FAST,
          composition: env.OPENAI_MODEL_SMART,
          embedding: env.OPENAI_MODEL_EMBEDDING,
        },
      });
    }

    this.logger.info(
      { event: 'ai.not_configured', provider: env.AI_PRIMARY_PROVIDER },
      'No model provider configured; notifications will ship without summaries',
    );
    return null;
  }
}
