import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Reading an attachment, and everything needed to deliver it.
 *
 * One query rather than four, because every piece has to agree about the same
 * user: the attachment, the message it belongs to, the account it arrived on,
 * and the number it may be sent to. Fetching them separately invites a version
 * where three are scoped and the fourth is not.
 */
@Injectable()
export class AttachmentRepository {
  /**
   * Everything the media processor needs, or null.
   *
   * Null covers deleted, purged by the retention sweep, and belonging to
   * somebody else — and they are deliberately indistinguishable. Row-level
   * security makes the third one resolve to nothing without a `where` clause
   * anyone could forget, and an `attachmentId` that came in on a job is a value
   * a replayed job could have chosen.
   */
  async findForDelivery(userId: string, emailMessageId: string, attachmentId: string) {
    return this.prisma.forUser(userId, async (tx) => {
      const attachment = await tx.attachment.findFirst({
        // Both ids, not just the attachment's. An attachment id paired with a
        // *different* message is a job that should find nothing rather than a
        // job that quietly works.
        where: { id: attachmentId, emailMessageId, userId },
        select: {
          id: true,
          providerAttachmentId: true,
          filename: true,
          mimeType: true,
          sizeBytes: true,
          disposition: true,
          isMalicious: true,
        },
      });

      if (!attachment) return null;

      const [message, user, state] = await Promise.all([
        tx.emailMessage.findUnique({
          where: { id: emailMessageId },
          select: { accountId: true, providerMessageId: true, deletedAt: true },
        }),
        tx.user.findUnique({
          where: { id: userId },
          select: { phoneNumber: true, phoneVerified: true },
        }),
        tx.conversationState.findUnique({
          where: { userId },
          select: { lastInboundAt: true },
        }),
      ]);

      // A deleted message keeps its attachment rows until the sweep runs. The
      // user asked for it to go; handing them a file out of it afterwards is
      // the opposite of what they said.
      if (!message || message.deletedAt) return null;

      return {
        attachment,
        accountId: message.accountId,
        providerMessageId: message.providerMessageId,
        // The same seal every other delivery path applies: an unverified number
        // reads as no number at all. It decides where someone's private files
        // are sent, and nothing proved they own it.
        phoneNumber: user?.phoneVerified ? user.phoneNumber : null,
        lastInboundAt: state?.lastInboundAt ?? null,
      };
    });
  }

  /** The attachments worth offering for one email, in the order they arrived. */
  async listDeliverable(userId: string, emailMessageId: string) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.attachment.findMany({
        // Inline parts are signature logos and tracking pixels. Offering them
        // would bury the one file the user actually wants under three of them.
        where: { emailMessageId, userId, disposition: { not: 'inline' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, filename: true, mimeType: true, sizeBytes: true },
      }),
    );
  }

  constructor(private readonly prisma: PrismaService) {}
}
