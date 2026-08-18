import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.js';

/**
 * The people a user actually corresponds with.
 *
 * The table has existed since the first migration and `aliases` is *read* by
 * the thread resolver, which matches "reply to sarah" against it. Nothing ever
 * wrote a row, so that lookup has always run against an empty table for every
 * real user — a resolution rank that could not fire, and a seed script as its
 * only evidence of working.
 *
 * The address book is built from mail that has actually arrived rather than
 * imported from a provider's contacts API. Two reasons, and the second is the
 * one that decides it:
 *
 *  1. It needs no extra OAuth scope, and a contacts scope is one of the most
 *     invasive a mail app can ask for.
 *  2. It is a record of correspondence rather than of acquaintance, which is
 *     what "email sarah" means. Someone whose address is in a provider's
 *     contact list because they were once CC'd is not who the user means.
 */
export interface ContactMatch {
  emailAddress: string;
  displayName: string | null;
  messagesReceived: number;
}

@Injectable()
export class ContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records that a message arrived from someone.
   *
   * Runs inside the caller's transaction, so a contact is never recorded for a
   * message that failed to store — the address book would then name people
   * whose mail the user cannot find.
   *
   * The display name is only ever *filled in*, never overwritten: senders vary
   * how they set it between messages, and the first non-empty one is generally
   * the fullest. `aliases` is untouched here — those are names the user gave,
   * and a sender must not be able to change what their own address answers to.
   */
  async recordInbound(
    tx: ContactTransaction,
    userId: string,
    from: { address: string; name?: string },
    seenAt: Date,
  ): Promise<void> {
    const emailAddress = from.address.trim().toLowerCase();
    if (!emailAddress || !emailAddress.includes('@')) return;

    const displayName = from.name?.trim() || null;

    await tx.contact.upsert({
      where: { userId_emailAddress: { userId, emailAddress } },
      create: {
        userId,
        emailAddress,
        displayName,
        messagesReceived: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      },
      update: {
        messagesReceived: { increment: 1 },
        lastSeenAt: seenAt,
        // `displayName` is deliberately absent: overwriting it would let a
        // sender who signs one message with a single initial replace the name
        // the user knows them by. Filling a missing one happens below.
      },
    });

    if (displayName) {
      // Fill a missing name without touching one we already have. Prisma has no
      // "update only if null", so it is a second conditional write — cheap, and
      // only on the first message that carried a name.
      await tx.contact.updateMany({
        where: { userId, emailAddress, displayName: null },
        data: { displayName },
      });
    }
  }

  /**
   * People whose name or alias matches what the user typed.
   *
   * Ordered by how much mail has actually come from them, because "email sarah"
   * means the Sarah they correspond with rather than the one who mailed once
   * two years ago. The caller decides what to do with more than one — this
   * deliberately does not pick.
   */
  async findByName(userId: string, name: string, limit = 5): Promise<ContactMatch[]> {
    const wanted = name.trim().toLowerCase();
    if (wanted.length < 2) return [];

    return this.prisma.forUser(userId, async (tx) => {
      const rows = await tx.contact.findMany({
        where: {
          userId,
          isBlocked: false,
          OR: [
            { displayName: { equals: wanted, mode: 'insensitive' } },
            { displayName: { startsWith: `${wanted} `, mode: 'insensitive' } },
            { displayName: { contains: ` ${wanted}`, mode: 'insensitive' } },
            { aliases: { has: wanted } },
            { emailAddress: { startsWith: `${wanted}@` } },
          ],
        },
        orderBy: [{ messagesReceived: 'desc' }, { lastSeenAt: 'desc' }],
        take: limit,
        select: { emailAddress: true, displayName: true, messagesReceived: true },
      });

      return rows;
    });
  }

  /** The people the user hears from most, for "who do I email". */
  async listFrequent(userId: string, limit = 10): Promise<ContactMatch[]> {
    return this.prisma.forUser(userId, async (tx) =>
      tx.contact.findMany({
        where: { userId, isBlocked: false },
        orderBy: [{ messagesReceived: 'desc' }, { lastSeenAt: 'desc' }],
        take: limit,
        select: { emailAddress: true, displayName: true, messagesReceived: true },
      }),
    );
  }
}

/**
 * The transaction handle `recordInbound` runs on.
 *
 * Structurally typed rather than imported from the generated client, so the
 * seam stays exactly as wide as what is used and the repository can be
 * exercised without dragging Prisma's full transaction type in.
 */
export interface ContactTransaction {
  contact: {
    upsert(args: Record<string, unknown>): Promise<unknown>;
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
}
