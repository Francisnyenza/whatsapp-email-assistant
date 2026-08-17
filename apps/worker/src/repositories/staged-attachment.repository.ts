import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Files the user sent into the chat, waiting to go out on an email.
 *
 * Three properties of this table are load-bearing and none of them are obvious:
 *
 *  1. **It holds no bytes.** Only Meta's media id. A file the user staged and
 *     never sent is a file we never stored, which is the difference between a
 *     product that relays attachments and one that accumulates them.
 *  2. **`whatsappMessageId` is unique.** Meta redelivers a webhook on any
 *     non-2xx, so without it the same photo is attached twice — and an email
 *     carrying the same invoice twice is the kind of wrong the recipient sees.
 *  3. **Claiming is a conditional update.** The pending set is claimed by the
 *     draft that consumes it, in the same transaction that creates the draft,
 *     so two composes racing cannot both carry the same file.
 */
export interface StagedFile {
  id: string;
  whatsappMediaId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

@Injectable()
export class StagedAttachmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a file the user just sent.
   *
   * @returns the row, or null when this WhatsApp message was already staged —
   *   a redelivered webhook, which must be silent rather than an error.
   */
  async stage(input: {
    userId: string;
    whatsappMediaId: string;
    whatsappMessageId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    expiresAt: Date;
  }): Promise<StagedFile | null> {
    return this.prisma.forUser(input.userId, async (tx) => {
      const existing = await tx.stagedAttachment.findUnique({
        where: { whatsappMessageId: input.whatsappMessageId },
        select: SELECT,
      });
      if (existing) return null;

      return tx.stagedAttachment.create({
        data: {
          userId: input.userId,
          whatsappMediaId: input.whatsappMediaId,
          whatsappMessageId: input.whatsappMessageId,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          expiresAt: input.expiresAt,
        },
        select: SELECT,
      });
    });
  }

  /** This user's unclaimed, unexpired files, oldest first — the order they were sent. */
  async listPending(userId: string, now = new Date()): Promise<StagedFile[]> {
    return this.prisma.forUser(userId, async (tx) =>
      tx.stagedAttachment.findMany({
        where: { userId, draftId: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'asc' },
        select: SELECT,
      }),
    );
  }

  /**
   * Attaches the pending set to a draft.
   *
   * Runs inside the caller's transaction so it commits with the draft itself.
   * A draft created without its files, or files claimed by a draft that then
   * failed to create, are both states where the user is told one thing and the
   * recipient receives another.
   *
   * @returns how many files the draft picked up.
   */
  async claimForDraft(
    tx: PrismaTransaction,
    userId: string,
    draftId: string,
    now = new Date(),
  ): Promise<number> {
    const claimed = await tx.stagedAttachment.updateMany({
      where: { userId, draftId: null, expiresAt: { gt: now } },
      data: { draftId },
    });
    return claimed.count;
  }

  /** What a draft is carrying, in the order the user sent them. */
  async listForDraft(userId: string, draftId: string): Promise<StagedFile[]> {
    return this.prisma.forUser(userId, async (tx) =>
      tx.stagedAttachment.findMany({
        where: { draftId },
        orderBy: { createdAt: 'asc' },
        select: SELECT,
      }),
    );
  }

  /**
   * Forgets a file the user asked to drop.
   *
   * Only ever the unclaimed ones: a file already on a queued draft is on its
   * way out, and removing the row would not unsend it.
   */
  async discardPending(userId: string, now = new Date()): Promise<number> {
    return this.prisma.forUser(userId, async (tx) => {
      const removed = await tx.stagedAttachment.deleteMany({
        where: { userId, draftId: null, expiresAt: { gt: now } },
      });
      return removed.count;
    });
  }
}

const SELECT = {
  id: true,
  whatsappMediaId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
} as const;

/**
 * The transaction handle `claimForDraft` runs on.
 *
 * Structurally typed rather than imported from the generated client, so the
 * repository can be exercised against a fake without dragging Prisma's full
 * transaction type — and so the seam stays exactly as wide as what is used.
 */
export interface PrismaTransaction {
  stagedAttachment: {
    updateMany(args: {
      where: { userId: string; draftId: null; expiresAt: { gt: Date } };
      data: { draftId: string };
    }): Promise<{ count: number }>;
  };
}
