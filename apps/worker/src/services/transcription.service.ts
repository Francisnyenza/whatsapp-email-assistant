import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError } from '@wea/shared';
import { canTranscribe } from '@wea/ai';
import { AiService } from './ai.service.js';
import { OutboundService } from './outbound.service.js';
import { AnalysisRepository } from '../repositories/analysis.repository.js';

/**
 * Turning a voice note into the words the user said.
 *
 * `JOB.TRANSCRIBE_AUDIO` has been in the shared constants since Phase 2 with no
 * producer and no consumer, and the README claimed "send a voice note, get an
 * email" for most of the project's life. A voice note reached the webhook
 * parser, which understood it perfectly — `media.voice` is even parsed — and
 * then fell through to the text handler with no text, where it became "I'm not
 * sure what you meant".
 *
 * The transcript is treated as the user's own words, which is the correct trust
 * level: ADR 0004 separates the user's channel from email content, and a voice
 * note is the user's channel. What it is *not* is as reliable as typing, so the
 * caller echoes it back — a mis-transcription has to be visible in the same
 * message that acts on it.
 */

/**
 * Meta caps voice notes at 16 MB, and Whisper at 25 MB. The lower one is the
 * real limit, and reading past it is bytes we already know we cannot use.
 */
export const MAX_VOICE_NOTE_BYTES = 16 * 1024 * 1024;

@Injectable()
export class TranscriptionService {
  constructor(
    private readonly ai: AiService,
    private readonly outbound: OutboundService,
    private readonly analyses: AnalysisRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /** Whether this deployment can transcribe at all, without paying a round trip. */
  get available(): boolean {
    return canTranscribe(this.ai.provider());
  }

  /**
   * @param mediaId Meta's id for the recording.
   * @returns what the user said.
   * @throws {AppError} with a sentence the user reads — an unconfigured
   *   provider, an unintelligible recording and a failed download are three
   *   different disappointments and are worth telling apart.
   */
  async transcribe(userId: string, mediaId: string, language?: string): Promise<string> {
    const provider = this.ai.provider();

    if (!canTranscribe(provider)) {
      throw new AppError(
        'AI_UNAVAILABLE',
        provider
          ? `Provider ${provider.name} has no transcription capability`
          : 'No model provider configured',
        {
          retryable: false,
          publicMessage: provider
            ? "I can't turn voice notes into words with the model provider this deployment uses. Type it instead and I'll act on it."
            : "Voice notes aren't switched on in this deployment. Type it instead and I'll act on it.",
        },
      );
    }

    const audio = await this.outbound.fetchMedia(mediaId, MAX_VOICE_NOTE_BYTES);

    const result = await provider.transcribe({
      audio,
      // Ogg-Opus is what WhatsApp records. Declared rather than assumed, because
      // the filename the provider infers a decoder from is built from it.
      mimeType: 'audio/ogg',
      ...(language ? { language } : {}),
    });

    // Metered like every other model call. Transcription bills by duration
    // rather than by tokens, so the row carries zeroes and exists for the count.
    await this.analyses.recordUsage(userId, 'transcription', result.usage).catch((err: unknown) => {
      this.logger.warn(
        { event: 'transcription.metering_failed', err },
        'Could not record transcription usage',
      );
    });

    this.logger.info(
      // The words themselves are the user's private speech and stay out of the
      // log, exactly as an email body does.
      { event: 'transcription.completed', bytes: audio.length, chars: result.text.length },
      'Voice note transcribed',
    );

    return result.text;
  }
}
