import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import {
  AppError,
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  STAGED_ATTACHMENT_TTL_MS,
  type InboundWhatsAppMessage,
} from '@wea/shared';
import { OutboundService } from './outbound.service.js';
import { StagedAttachmentRepository } from '../repositories/staged-attachment.repository.js';

/**
 * Accepting a file the user sends into the chat.
 *
 * The mirror of `MediaProcessor`, and the direction that was missing: an email's
 * attachments could be delivered into WhatsApp, and a photo sent back was
 * understood by the webhook parser and then dropped on the floor.
 *
 * What makes this different from every other command is that nothing happens
 * yet. A file arrives with no instruction — often with no caption at all — so it
 * is *held*, and the next email the user sends carries it. That is the only
 * model that works in a chat: there is no draft window to keep open, and asking
 * "who is this for?" before accepting the file would lose it if the user
 * answered with a new thought instead.
 *
 * Holding it has one consequence worth stating: the file has to be acknowledged
 * out loud. A photo sent into a chat that answers nothing is indistinguishable
 * from a photo that was ignored, and the user finds out which at the moment the
 * email arrives without it.
 */

export type StagingOutcome =
  | { kind: 'staged'; filename: string; sizeBytes: number; pendingCount: number }
  /** Already seen — a redelivered webhook. Say nothing; the first one was answered. */
  | { kind: 'duplicate' }
  /** Understood, and refused, with a sentence the user reads. */
  | { kind: 'refused'; reason: string };

@Injectable()
export class AttachmentStagingService {
  constructor(
    private readonly outbound: OutboundService,
    private readonly staged: StagedAttachmentRepository,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Whether this message is a file to hold rather than a command to run.
   *
   * Stickers and voice notes are deliberately excluded, and for opposite
   * reasons. A sticker is a reaction, not a document — nobody has ever meant to
   * email one. A voice note is dictation the product cannot yet transcribe, and
   * silently attaching a 4-second `.ogg` to someone's email would be a strange
   * answer to "reply saying I'll be there at six".
   */
  static isFile(message: InboundWhatsAppMessage): boolean {
    if (!message.media) return false;
    if (message.type === 'sticker') return false;
    if (message.type === 'audio' && message.media.voice === true) return false;
    return (
      message.type === 'image' ||
      message.type === 'document' ||
      message.type === 'audio' ||
      message.type === 'video'
    );
  }

  async stage(userId: string, message: InboundWhatsAppMessage): Promise<StagingOutcome> {
    const media = message.media;
    if (!media) return { kind: 'refused', reason: NOT_A_FILE };

    // Meta's webhook names the file and its type and never its size, so the
    // budget cannot be checked without asking. Asking costs one call and is the
    // difference between refusing now and failing after "sending…".
    let described: { mimeType: string; sizeBytes: number };
    try {
      described = await this.outbound.describeMedia(media.id);
    } catch (err) {
      this.logger.warn(
        { event: 'staging.describe_failed', err, mediaType: message.type },
        'Could not read media metadata',
      );
      throw AppError.from(err);
    }

    if (described.sizeBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      return { kind: 'refused', reason: tooLarge(described.sizeBytes) };
    }

    // The running total matters as much as the single file: three 8 MB photos
    // are individually fine and together are an email no provider will accept.
    const pending = await this.staged.listPending(userId);
    const pendingBytes = pending.reduce((total, file) => total + file.sizeBytes, 0);

    if (pendingBytes + described.sizeBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      return { kind: 'refused', reason: overBudget(pending.length) };
    }

    if (pending.length >= MAX_PENDING_FILES) {
      return { kind: 'refused', reason: tooMany() };
    }

    const filename = fileNameFor(message, described.mimeType);

    const row = await this.staged.stage({
      userId,
      whatsappMediaId: media.id,
      whatsappMessageId: message.id,
      filename,
      // Meta's metadata is authoritative over the webhook's echo of it: the
      // webhook reports what the client claimed, and the bytes are what the
      // recipient's mail client will sniff anyway.
      mimeType: described.mimeType,
      sizeBytes: described.sizeBytes,
      expiresAt: new Date(message.timestamp.getTime() + STAGED_ATTACHMENT_TTL_MS),
    });

    if (!row) {
      this.logger.info(
        { event: 'staging.duplicate', waMessageId: message.id },
        'Webhook redelivered a file that is already staged',
      );
      return { kind: 'duplicate' };
    }

    this.logger.info(
      // The filename is a fact about the user's own documents, so it stays out
      // of the log, exactly as it does on the delivery side.
      {
        event: 'staging.staged',
        mediaType: message.type,
        mimeType: described.mimeType,
        bytes: described.sizeBytes,
        pending: pending.length + 1,
      },
      'File staged for the next outgoing email',
    );

    return {
      kind: 'staged',
      filename,
      sizeBytes: described.sizeBytes,
      pendingCount: pending.length + 1,
    };
  }

  /** What the user is holding, for the acknowledgement and for `carry nothing`. */
  async pending(userId: string) {
    return this.staged.listPending(userId);
  }

  /** Drops everything unclaimed. Files already on a queued draft are already gone. */
  async discard(userId: string): Promise<number> {
    return this.staged.discardPending(userId);
  }
}

/**
 * A ceiling on count as well as bytes.
 *
 * Ten small files are within budget and still make a message no recipient wants
 * to receive, and each one is a metadata call and a download at send time.
 */
export const MAX_PENDING_FILES = 10;

/**
 * The name the recipient will see.
 *
 * Documents carry one. Photos, video and audio do not — WhatsApp strips it — so
 * one is invented from the type and the moment it was sent. `image.jpg` for
 * every photo would be worse than a timestamp: a recipient receiving three of
 * them cannot tell which is which, and some clients silently drop the
 * duplicates.
 */
export function fileNameFor(message: InboundWhatsAppMessage, mimeType: string): string {
  const given = message.media?.filename?.trim();
  if (given) return sanitizeFilename(given);

  const stamp = message.timestamp
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/[TZ]/g, (c) => (c === 'T' ? '_' : ''));

  return `${message.type}-${stamp}.${extensionFor(mimeType)}`;
}

/**
 * Filenames arrive from a client we do not control and end up in a MIME header.
 *
 * A newline here is a header injection; a path separator is an attempt to write
 * somewhere else if a recipient's client is careless with saving. Neither is
 * likely and both are cheap to remove.
 */
function sanitizeFilename(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) continue;
    if (char === '/' || char === '\\' || char === '"') continue;
    cleaned += char;
  }
  cleaned = cleaned.trim().slice(0, MAX_FILENAME_CHARS);
  return cleaned || 'attachment';
}

const MAX_FILENAME_CHARS = 120;

function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
  };

  const exact = known[mimeType.split(';')[0]!.trim().toLowerCase()];
  if (exact) return exact;

  // `image/heic` → `heic`, and anything unrecognised keeps a plausible
  // extension rather than none, which is what makes a client offer to open it.
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  return subtype && /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'bin';
}

const NOT_A_FILE = 'That did not arrive as a file I can attach.';

function tooLarge(bytes: number): string {
  return (
    `That file is ${megabytes(bytes)} MB, and email caps out around ` +
    `${megabytes(MAX_OUTBOUND_ATTACHMENT_BYTES)} MB. Send a smaller version, or a link to it.`
  );
}

function overBudget(pendingCount: number): string {
  return (
    `That would push the attachments past ${megabytes(MAX_OUTBOUND_ATTACHMENT_BYTES)} MB, ` +
    `which is more than email will carry. ${
      pendingCount === 1 ? 'One file is' : `${pendingCount} files are`
    } already waiting — send them first, or say _drop the files_ to start over.`
  );
}

function tooMany(): string {
  return (
    `I'm already holding ${MAX_PENDING_FILES} files. Send them first, ` +
    'or say _drop the files_ to start over.'
  );
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
}
