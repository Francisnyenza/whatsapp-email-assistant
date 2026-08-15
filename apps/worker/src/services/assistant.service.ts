import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, type EmailAnalysis } from '@wea/shared';
import { analyzeEmail, translateEmail, draftReply, prepareSpeech, canSpeak } from '@wea/ai';
import { AiService } from './ai.service.js';
import { AccountService } from './account.service.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';
import { MessageRepository } from '../repositories/message.repository.js';

/**
 * The verbs that ask a model something about one email: "summarise this",
 * "translate it into Swahili", "reply saying I'll have it by Friday".
 *
 * None of them can send, move or delete anything — there is no path from this
 * class to a mailbox mutation, which is the same guarantee ADR 0004 makes
 * everywhere else. Summarise and translate are therefore answered immediately;
 * `draftReply` is the one that produces words which *could* be sent, and it
 * still only returns them. The caller stores them and asks.
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
   * One email as a voice note.
   *
   * Returns bytes rather than sending them, for the same reason `draftReply`
   * returns text: this class has no path to WhatsApp and gains none here.
   *
   * The provider check is `canSpeak` rather than a truthiness test, and that
   * distinction is the whole reason the capability is optional. A deployment on
   * Anthropic has a perfectly working provider that cannot speak — so "no
   * provider" and "this provider does not do speech" are different sentences to
   * the user, and only the second one is worth suggesting a fix for.
   *
   * @throws {AppError} `AI_UNAVAILABLE` when nothing configured can speak,
   *   `NOT_FOUND` when the message is gone. Both become a specific sentence.
   */
  async readAloud(userId: string, emailMessageId: string): Promise<SpokenEmail> {
    const provider = this.ai.provider();

    if (!canSpeak(provider)) {
      throw new AppError(
        'AI_UNAVAILABLE',
        provider
          ? `Provider ${provider.name} has no speech capability`
          : 'No model provider configured',
        {
          retryable: false,
          publicMessage: provider
            ? "I can't read emails aloud with the voice provider this deployment uses."
            : "I can't read emails aloud — no AI provider is set up.",
        },
      );
    }

    await this.assertAffordable(userId);

    const message = await this.messages.findForAnalysis(userId, emailMessageId);
    if (!message) throw new AppError('NOT_FOUND', 'Message is gone', { retryable: false });

    // Prepared before the call, not after. What gets spoken is a product
    // decision — how much of an email is worth listening to, whose name is
    // announced first, where quoted history stops — and none of it belongs to
    // whichever vendor happens to be encoding the audio.
    const script = prepareSpeech({
      fromName: message.fromName,
      fromAddress: message.fromAddress,
      subject: message.subject,
      body: await this.body(userId, message),
    });

    const spoken = await provider.speak({ text: script.text });

    await this.analyses.recordUsage(userId, 'speech', spoken.usage);

    this.logger.info(
      {
        event: 'assistant.read_aloud',
        emailMessageId,
        truncated: script.truncated,
        bytes: spoken.audio.length,
      },
      'Email read aloud',
    );

    return {
      audio: spoken.audio,
      mimeType: spoken.mimeType,
      truncated: script.truncated,
    };
  }

  /**
   * A reply the user might send, in their voice.
   *
   * Returns text and nothing else — no recipient, no subject, no headers. Those
   * are computed server-side from the original when the user confirms
   * (ADR 0003), so nothing the model or the email says can redirect a reply.
   * Nothing here sends anything; the caller stores the words and asks.
   */
  async draftReply(userId: string, emailMessageId: string, instruction?: string): Promise<string> {
    const provider = this.ai.provider();
    if (!provider) {
      throw new AppError('AI_UNAVAILABLE', 'No model provider configured', { retryable: false });
    }

    await this.assertAffordable(userId);

    const message = await this.messages.findForAnalysis(userId, emailMessageId);
    if (!message) throw new AppError('NOT_FOUND', 'Message is gone', { retryable: false });

    const result = await draftReply(provider, {
      subject: message.subject,
      ...(message.fromName ? { fromName: message.fromName } : {}),
      fromAddress: message.fromAddress,
      bodyText: await this.body(userId, message),
      ...(instruction ? { instruction } : {}),
      ...(message.locale ? { locale: message.locale } : {}),
    });

    await this.analyses.recordUsage(userId, 'composition', result.usage);

    this.logger.info(
      { event: 'assistant.drafted', emailMessageId, guided: Boolean(instruction) },
      'Reply drafted for confirmation',
    );

    return result.data;
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

export interface SpokenEmail {
  audio: Buffer;
  /** From the provider that encoded it — WhatsApp rejects a mismatch. */
  mimeType: string;
  /** True when the email was longer than a voice note; the audio says so too. */
  truncated: boolean;
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
