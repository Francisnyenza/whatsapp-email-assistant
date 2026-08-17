import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service.js';

/**
 * Messages the user has put down until later.
 *
 * The table has existed since the first migration, with an index whose comment
 * reads "drives the due-reminder sweep", and there was no sweep, no producer and
 * no repository. This is that.
 *
 * The sweep that finds due reminders runs on a timer and therefore has no
 * tenant, which `reminders` — being under row-level security — has no way to
 * express. So it does what the digest sweep does: enumerate user ids from
 * `users`, which carries no policy because a user *is* the tenant, then ask this
 * question once per user inside their own transaction. One indexed lookup each,
 * and no scheduled job that can read every mailbox.
 */
export interface DueReminder {
  id: string;
  emailMessageId: string;
}

@Injectable()
export class ReminderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    userId: string;
    emailMessageId: string;
    remindAt: Date;
    reason: string;
  }): Promise<{ id: string }> {
    return this.prisma.forUser(input.userId, async (tx) => {
      // One live snooze per message. Snoozing twice is the user changing their
      // mind, not asking for the message twice — and two rows would return it
      // twice, an hour apart, for reasons they could never reconstruct.
      await tx.reminder.updateMany({
        where: {
          userId: input.userId,
          emailMessageId: input.emailMessageId,
          sentAt: null,
          cancelledAt: null,
        },
        data: { cancelledAt: new Date() },
      });

      return tx.reminder.create({
        data: {
          userId: input.userId,
          emailMessageId: input.emailMessageId,
          remindAt: input.remindAt,
          reason: input.reason,
        },
        select: { id: true },
      });
    });
  }

  /**
   * Reminders whose time has come.
   *
   * Capped per sweep: a backlog after an outage is drained over successive ticks
   * rather than in one burst that would rate-limit us out of the provider API
   * and take ingest down with it.
   */
  async findDueFor(userId: string, now: Date, limit: number): Promise<DueReminder[]> {
    return this.prisma.forUser(userId, async (tx) => {
      const rows = await tx.reminder.findMany({
        where: {
          userId,
          remindAt: { lte: now },
          sentAt: null,
          cancelledAt: null,
          emailMessageId: { not: null },
        },
        orderBy: { remindAt: 'asc' },
        take: limit,
        select: { id: true, emailMessageId: true },
      });

      return rows
        .filter(
          (row): row is typeof row & { emailMessageId: string } => row.emailMessageId !== null,
        )
        .map((row) => ({ id: row.id, emailMessageId: row.emailMessageId }));
    });
  }

  /**
   * Claims a reminder, so a second worker on the same tick does not deliver it
   * twice.
   *
   * A conditional update rather than a read-then-write: two workers racing means
   * exactly one `updateMany` matches, and the loser stops.
   */
  async claim(userId: string, reminderId: string): Promise<boolean> {
    return this.prisma.forUser(userId, async (tx) => {
      const claimed = await tx.reminder.updateMany({
        where: { id: reminderId, sentAt: null, cancelledAt: null },
        data: { sentAt: new Date() },
      });
      return claimed.count === 1;
    });
  }

  /** Releases a claim whose delivery failed, so the next sweep tries again. */
  async release(userId: string, reminderId: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.reminder.updateMany({ where: { id: reminderId }, data: { sentAt: null } });
    });
  }

  /**
   * Cancels the snooze on a message.
   *
   * Called when the user acts on it themselves before the time comes — a reply,
   * an archive, a delete. Bringing a message back that they have already dealt
   * with is the behaviour that makes people stop trusting snooze.
   */
  async cancelFor(userId: string, emailMessageId: string): Promise<number> {
    return this.prisma.forUser(userId, async (tx) => {
      const cancelled = await tx.reminder.updateMany({
        where: { userId, emailMessageId, sentAt: null, cancelledAt: null },
        data: { cancelledAt: new Date() },
      });
      return cancelled.count;
    });
  }

  /** What the user has put down until later, soonest first. */
  async listPending(userId: string, now: Date, limit: number) {
    return this.prisma.forUser(userId, async (tx) =>
      tx.reminder.findMany({
        where: { userId, sentAt: null, cancelledAt: null, remindAt: { gt: now } },
        orderBy: { remindAt: 'asc' },
        take: limit,
        select: { id: true, remindAt: true, emailMessageId: true },
      }),
    );
  }
}
