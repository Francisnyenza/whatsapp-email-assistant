import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, type EmailAnalysis } from '@wea/shared';
import { analyzeEmail, translateEmail } from '@wea/ai';
import { AiService } from './ai.service.js';
import { AccountService } from './account.service.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';

/**
 * The verbs that ask a model something about one email: "summarise this",
 * "translate it into Swahili".
 *
 * Both are reads. Neither can send, move or delete anything — there is no path
 * from here to a mailbox mutation, which is the same guarantee ADR 0004 makes
 * everywhere else and is why these can answer immediately rather than through a
 * confirmation tap.
 *
 * Summarising is deliberately not a model call in the common case. Every
 * inbound email is already analysed, and that analysis contains the summary the
 * notification card showed. Asking again would be paying twice for the same
 * sentence — so the stored one is returned, and the model is only reached for a
 * message that has none, which also stores the result for next time.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly ai: AiService,
    private readonly accounts: AccountService,
    private readonly analyses: AnalysisRepository,
    private readonly messages: MessageRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * A summary of one email.
   *
   * @throws {AppError} `NOT_FOUND` when the message is gone, `AI_UNAVAILABLE`
   *   when there is nothing stored and no provider to produce one. Both become
   *   a specific sentence rather than silence.
   */
  async summarize(userId: string, emailMessageId: string): Promise<string> {
    const stored = await this.analyses.find(userId, emailMessageId);
    if (stored) return render(stored);

    const analysis = await this.analyseNow(userId, emailMessageId);
    return render(analysis);
  }

  /** One email in another language. */
  async translate(userId: string, emailMessageId: string, language: string): Promise<string> {
    const provider = this.ai.provider();
    if (!provider) {
      throw new AppError('AI_UNAVAILABLE', 'No model provider configured', { retryable: false });
    }

    await this.assertAffordable(userId);

    const message = await this.messages.findForAnalysis(userId, emailMessageId);
    if (!message) throw new AppError('NOT_FOUND', 'Message is gone', { retryable: false });

    const result = await translateEmail(provider, {
      subject: message.subject,
      bodyText: await this.body(userId, message),
      targetLanguage: language,
    });

    await this.analyses.recordUsage(userId, 'translation', result.usage);

    this.logger.info(
      { event: 'assistant.translated', emailMessageId, truncated: result.data.truncated },
      'Email translated',
    );

    return result.data.truncated
      ? `${result.data.text}\n\n_(translated the first part — the email is longer than fits here)_`
      : result.data.text;
  }

  /**
   * Analysis on demand, for a message that never got one.
   *
   * The result is stored, so a user who asks twice pays once — and so does the
   * notification card if it is ever re-sent. That is worth more than it sounds:
   * the usual reason an email has no analysis is that the provider was down or
   * the budget was spent when it arrived, and both of those pass.
   */
  private async analyseNow(userId: string, emailMessageId: string): Promise<EmailAnalysis> {
    const provider = this.ai.provider();
    if (!provider) {
      throw new AppError('AI_UNAVAILABLE', 'No model provider configured', { retryable: false });
    }

    await this.assertAffordable(userId);

    const message = await this.messages.findForAnalysis(userId, emailMessageId);
    if (!message) throw new AppError('NOT_FOUND', 'Message is gone', { retryable: false });

    const result = await analyzeEmail(provider, {
      subject: message.subject,
      ...(message.fromName ? { fromName: message.fromName } : {}),
      fromAddress: message.fromAddress,
      bodyText: await this.body(userId, message),
      ...(message.locale ? { locale: message.locale } : {}),
    });

    await this.analyses.save(userId, emailMessageId, result.data, result.usage, result.cached);
    await this.analyses.recordUsage(userId, 'analysis', result.usage, { cached: result.cached });

    return result.data;
  }

  private async assertAffordable(userId: string): Promise<void> {
    if (await this.ai.isOverBudget(userId)) {
      throw new AppError('QUOTA_EXCEEDED', 'Daily token budget spent', { retryable: false });
    }
  }

  /**
   * The body, or the snippet.
   *
   * Same fallback as analysis at ingest: bodies are purged on the retention
   * schedule, so an email we can still act on may have only its 300-character
   * preview. Thin, and much better than refusing.
   */
  private async body(
    userId: string,
    message: {
      snippet: string;
      bodyTextCipher: Uint8Array | null;
      bodyDek: Uint8Array | null;
      bodyKeyVersion: number | null;
    },
  ): Promise<string> {
    if (!message.bodyTextCipher || !message.bodyDek || message.bodyKeyVersion === null) {
      return message.snippet;
    }

    try {
      return await this.accounts.decryptMessageBody(userId, {
        ciphertext: Buffer.from(message.bodyTextCipher),
        wrappedKey: Buffer.from(message.bodyDek),
        keyVersion: message.bodyKeyVersion,
      });
    } catch (err) {
      this.logger.warn(
        { event: 'assistant.body_unavailable', err },
        'Could not decrypt the body; using the snippet instead',
      );
      return message.snippet;
    }
  }
}

/**
 * An analysis as something to read on a phone.
 *
 * Bullets when there are any, because a glance at a lock screen is the whole
 * use case — and the warning last, where it is the thing left on screen, rather
 * than buried above three bullet points.
 */
function render(
  analysis: Pick<EmailAnalysis, 'summary' | 'bulletSummary' | 'containsInstructionLikeText'>,
): string {
  const lines = [analysis.summary];

  if (analysis.bulletSummary.length > 0) {
    lines.push('');
    lines.push(...analysis.bulletSummary.slice(0, 5).map((point) => `• ${point}`));
  }

  if (analysis.containsInstructionLikeText) {
    // Surfaced here as well as on the card. Someone asking for a summary may
    // never have seen the original notification.
    lines.push('');
    lines.push('⚠️ This email contains text aimed at an automated assistant.');
  }

  return lines.join('\n');
}
