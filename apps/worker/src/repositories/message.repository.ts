import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { NormalizedMessage } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Persisting inbound mail.
 *
 * The property everything else depends on is idempotency. Gmail redelivers
 * history records freely, a Pub/Sub push can arrive twice, and a reconcile
 * sweep deliberately re-walks ground push already covered. Every one of those
 * paths lands here, so "store this message" has to mean "ensure this message is
 * stored" — persisting twice would notify the user twice, which is the most
 * visible bug this system could have.
 */

export interface PersistResult {
  emailMessageId: string;
  threadId: string;
  /** False when the message was already stored — the caller skips notifying. */
  isNew: boolean;
}

/**
 * The message body, already encrypted.
 *
 * Sealed by the caller rather than here, so key material lives in one service
 * and this repository never holds any (ADR 0002).
 */
export interface SealedBody {
  ciphertext: Buffer;
  wrappedKey: Buffer;
  keyVersion: number;
}

@Injectable()
export class MessageRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stores a message, or returns the existing one.
   *
   * The unique constraint on `(accountId, providerMessageId)` is what makes this
   * safe under concurrency: two workers racing on the same message means one
   * insert succeeds and the other's `createMany` skips, and both then read the
   * same row.
   */
  async persist(
    userId: string,
    accountId: string,
    message: NormalizedMessage,
    /**
     * Omitted when the body could not be sealed. Storing the message without it
     * is the right trade: a notification the user receives beats a message
     * dropped over an encryption failure, and the body can be re-fetched.
     */
    body?: SealedBody,
  ): Promise<PersistResult> {
    return this.prisma.forUser(userId, async (tx) => {
      const existing = await tx.emailMessage.findUnique({
        where: {
          accountId_providerMessageId: { accountId, providerMessageId: message.providerMessageId },
        },
        select: { id: true, threadId: true },
      });

      if (existing) {
        return { emailMessageId: existing.id, threadId: existing.threadId, isNew: false };
      }

      // The thread may already exist from an earlier message in the same
      // conversation, so it is upserted rather than created.
      const thread = await tx.emailThread.upsert({
        where: {
          accountId_providerThreadId: { accountId, providerThreadId: message.providerThreadId },
        },
        create: {
          userId,
          accountId,
          providerThreadId: message.providerThreadId,
          subject: message.subject,
          lastMessageAt: message.receivedAt,
          hasUnread: message.isUnread,
          participantAddresses: participantsOf(message),
        },
        update: {
          lastMessageAt: message.receivedAt,
          messageCount: { increment: 1 },
          ...(message.isUnread ? { hasUnread: true } : {}),
        },
        select: { id: true },
      });

      // createMany with skipDuplicates compiles to ON CONFLICT DO NOTHING, so a
      // concurrent insert of the same message is a no-op rather than a crash.
      const created = await tx.emailMessage.createMany({
        data: [
          {
            userId,
            accountId,
            threadId: thread.id,
            providerMessageId: message.providerMessageId,
            messageIdHeader: message.messageIdHeader,
            inReplyTo: message.inReplyTo ?? null,
            references: message.references,
            direction: 'inbound',
            subject: message.subject,
            fromAddress: message.from.address,
            fromName: message.from.name ?? null,
            replyTo: message.replyTo?.address ?? null,
            toAddresses: message.to.map((a) => a.address),
            ccAddresses: message.cc.map((a) => a.address),
            bccAddresses: message.bcc.map((a) => a.address),
            sentAt: message.sentAt,
            receivedAt: message.receivedAt,
            snippet: message.snippet.slice(0, 300),
            // Uint8Array rather than Buffer: Prisma's Bytes maps to
            // Uint8Array<ArrayBuffer>, and Node's Buffer widens to
            // ArrayBufferLike, which TypeScript rejects.
            ...(body
              ? {
                  bodyTextCipher: new Uint8Array(body.ciphertext),
                  bodyDek: new Uint8Array(body.wrappedKey),
                  bodyKeyVersion: body.keyVersion,
                }
              : {}),
            isUnread: message.isUnread,
            isStarred: message.isStarred,
            isDraft: message.isDraft,
            hasAttachments: message.attachments.length > 0,
            labels: message.labels,
            sizeBytes: message.sizeBytes,
            contentHash: contentHashOf(message),
          },
        ],
        skipDuplicates: true,
      });

      const stored = await tx.emailMessage.findUnique({
        where: {
          accountId_providerMessageId: { accountId, providerMessageId: message.providerMessageId },
        },
        select: { id: true },
      });

      if (message.attachments.length > 0 && created.count > 0 && stored) {
        await tx.attachment.createMany({
          data: message.attachments.map((attachment) => ({
            userId,
            emailMessageId: stored.id,
            providerAttachmentId: attachment.providerAttachmentId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            disposition: attachment.disposition,
            contentId: attachment.contentId ?? null,
          })),
          skipDuplicates: true,
        });
      }

      return {
        emailMessageId: stored!.id,
        threadId: thread.id,
        // `created.count` is 0 when a concurrent worker won the race. Both
        // return the same row, but only the winner notifies.
        isNew: created.count > 0,
      };
    });
  }

  /** Everything the notification card needs, in one read. */
  async findForNotification(userId: string, emailMessageId: string) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: {
          id: true,
          subject: true,
          fromAddress: true,
          fromName: true,
          receivedAt: true,
          hasAttachments: true,
          analysis: {
            select: {
              summary: true,
              priority: true,
              category: true,
              suggestedReplies: true,
              containsInstructionLikeText: true,
            },
          },
          attachments: { select: { filename: true } },
        },
      }),
    );
  }

  /** Advances the account's sync position. */
  async setCursor(userId: string, accountId: string, cursor: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: { syncCursor: cursor, lastSyncedAt: new Date(), consecutiveFailures: 0 },
      });
    });
  }

  /**
   * Records that a notification was held back.
   *
   * The only thing that makes a digest possible: without it, "deferred" and
   * "delivered" are indistinguishable afterwards, and the held mail is simply
   * never sent. Suppressed mail deliberately does not come through here — a
   * mute is the user saying they do not want to hear about it, and resurfacing
   * it in a digest would override them.
   */
  async markDeferred(userId: string, emailMessageId: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailMessage.updateMany({
        // Only if it is not already waiting: re-deferring would reset the clock,
        // and how long something has been waiting is what tells a working digest
        // from one that quietly stopped.
        where: { id: emailMessageId, notifyDeferredAt: null },
        data: { notifyDeferredAt: new Date() },
      });
    });
  }

  /** Clears the backlog flag once a message has actually been delivered. */
  async markNotified(userId: string, emailMessageIds: string[]): Promise<void> {
    if (emailMessageIds.length === 0) return;
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailMessage.updateMany({
        where: { id: { in: emailMessageIds } },
        data: { notifyDeferredAt: null },
      });
    });
  }

  /**
   * What this user is still owed, oldest first.
   *
   * Archived, deleted and spam are excluded: the user has already dealt with
   * them elsewhere, and a digest offering mail they binned yesterday reads as
   * broken.
   */
  async findDeferred(userId: string, limit = 20) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findMany({
        where: {
          notifyDeferredAt: { not: null },
          isArchived: false,
          isSpam: false,
          deletedAt: null,
        },
        orderBy: { receivedAt: 'asc' },
        take: limit,
        select: {
          id: true,
          fromAddress: true,
          fromName: true,
          subject: true,
          receivedAt: true,
          analysis: { select: { priority: true, summary: true } },
        },
      }),
    );
  }

  /** How many are waiting, for the digest template's one placeholder. */
  async countDeferred(userId: string): Promise<number> {
    return this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.count({
        where: {
          notifyDeferredAt: { not: null },
          isArchived: false,
          isSpam: false,
          deletedAt: null,
        },
      }),
    );
  }

  /** Notes that a digest just went out, so the sweep does not send another at the next tick. */
  async recordDigestSent(userId: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.conversationState.updateMany({
        where: { userId },
        data: { lastDigestAt: new Date() },
      });
    });
  }

  /** Records a sync failure, for the back-off and the health view. */
  async recordSyncFailure(userId: string, accountId: string, code: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: {
          consecutiveFailures: { increment: 1 },
          lastErrorCode: code,
          lastErrorAt: new Date(),
        },
      });
    });
  }

  /** The user's notification preferences and messaging-window state. */
  async findDeliveryContext(userId: string) {
    return this.prisma.forUser(userId, async (tx) => {
      const [preferences, state, user] = await Promise.all([
        tx.userPreference.findUnique({ where: { userId } }),
        tx.conversationState.findUnique({
          where: { userId },
          select: { lastInboundAt: true, lastDigestAt: true },
        }),
        tx.user.findUnique({
          where: { id: userId },
          select: { phoneNumber: true, timezone: true, locale: true },
        }),
      ]);
      return { preferences, state, user };
    });
  }
}

function participantsOf(message: NormalizedMessage): string[] {
  return [...new Set([message.from.address, ...message.to.map((a) => a.address)])];
}

/**
 * Identifies identical content across mailboxes.
 *
 * Normalized so that the same newsletter sent to ten thousand people hashes
 * once, letting them share a single AI analysis rather than paying for ten
 * thousand.
 */
function contentHashOf(message: NormalizedMessage): string {
  // Subject and body are normalized identically. Collapsing whitespace in one
  // but only trimming the other means the same newsletter hashes differently
  // depending on which half a mail server reformatted — which defeats the whole
  // purpose of the hash.
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256')
    .update(`${normalize(message.subject)}\n${normalize(message.bodyText)}`)
    .digest('hex');
}
