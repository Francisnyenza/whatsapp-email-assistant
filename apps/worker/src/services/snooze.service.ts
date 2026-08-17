import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, QUEUE, JOB } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';
import { MailboxActionService } from './mailbox-action.service.js';
import { ReminderRepository } from '../repositories/reminder.repository.js';
import { QueueProducer } from '../queue/queue.producer.js';
import { parseSnoozeTime } from './snooze-time.js';

/**
 * Putting a message down until later.
 *
 * Snooze is two halves that must not come apart. The message leaves the inbox
 * now, and it comes back at a stated time — and of the two, the second is the
 * one users are trusting. A snooze that archives and then forgets is worse than
 * no snooze at all, because the user has stopped thinking about the message and
 * nothing will remind them.
 *
 * So the order is: parse the time first, write the reminder second, and touch
 * the mailbox last. Each step can fail and leave a state that is honest:
 *
 *  * A time we cannot read means nothing has happened yet and the user is asked
 *    again.
 *  * A reminder that could not be written means the message is still in the
 *    inbox, where they will see it.
 *  * A mailbox we could not reach means the message is still in the inbox and a
 *    reminder will bring it up anyway, which is redundant rather than lost.
 *
 * The reverse order — archive, then try to remember — has a failure mode where
 * the message is gone and nothing is coming.
 */
@Injectable()
export class SnoozeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailbox: MailboxActionService,
    private readonly reminders: ReminderRepository,
    private readonly queue: QueueProducer,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * @returns how the resolved time reads in the user's own terms, which is what
   *   they are told. "Until Monday" is not a confirmation — "Monday 24 Aug,
   *   08:00" is, and it is the only version they can catch a mistake in.
   */
  async snooze(
    userId: string,
    emailMessageId: string,
    until: string,
    now = new Date(),
  ): Promise<{ description: string; at: Date }> {
    const timezone = await this.timezoneOf(userId);

    const when = parseSnoozeTime(until, { now, timezone });
    if (!when) {
      throw new AppError('BAD_REQUEST', 'Could not read a snooze time', {
        retryable: false,
        publicMessage:
          `I couldn't work out when “${until.trim()}” is. ` +
          'Try _snooze until tomorrow_, _snooze for 2 hours_, or _snooze until Monday 9am_.',
      });
    }

    await this.reminders.create({
      userId,
      emailMessageId,
      remindAt: when.at,
      reason: 'snooze',
    });

    // Out of the inbox, which is the half the user can see immediately. It is
    // last because a failure here leaves the message visible *and* remembered,
    // and that is the harmless way round.
    await this.mailbox.apply(userId, emailMessageId, { kind: 'archive' });

    this.logger.info({ event: 'snooze.set', emailMessageId, remindAt: when.at }, 'Message snoozed');

    return { description: when.description, at: when.at };
  }

  /**
   * Brings one back.
   *
   * The claim is taken first and released on failure, so two workers on the same
   * tick cannot both return the message — and a crash between the claim and the
   * delivery leaves the reminder to the next sweep rather than swallowing it.
   *
   * The notification itself is the ordinary one, forced past the user's
   * notification preferences. That is deliberate: they asked for this message at
   * this moment, and quiet hours are a rule about mail arriving unbidden.
   */
  async fire(userId: string, reminderId: string, emailMessageId: string): Promise<boolean> {
    const claimed = await this.reminders.claim(userId, reminderId);
    if (!claimed) return false;

    try {
      await this.mailbox.apply(userId, emailMessageId, { kind: 'unarchive' });

      await this.queue.enqueue(
        QUEUE.NOTIFY,
        JOB.NOTIFY_EMAIL,
        { userId, emailMessageId, force: true },
        // Keyed on the reminder, so a retried sweep cannot deliver it twice.
        { jobId: `notify:reminder:${reminderId}` },
      );

      this.logger.info({ event: 'snooze.returned', emailMessageId }, 'Snoozed message returned');
      return true;
    } catch (err) {
      // Put it back, so the next sweep tries again rather than the message
      // staying archived with nothing coming for it.
      await this.reminders.release(userId, reminderId).catch(() => {
        // A failure to release must not mask the original failure.
      });
      throw err;
    }
  }

  /**
   * Forgets the snooze on a message the user has since dealt with.
   *
   * Returning something they already replied to or archived is what makes people
   * stop trusting snooze — and unlike the other direction, they cannot tell it
   * was a bug rather than the feature working as designed.
   */
  async cancelFor(userId: string, emailMessageId: string): Promise<number> {
    const cancelled = await this.reminders.cancelFor(userId, emailMessageId);

    if (cancelled > 0) {
      this.logger.info(
        { event: 'snooze.cancelled', emailMessageId, cancelled },
        'Snooze cancelled because the user acted on the message',
      );
    }

    return cancelled;
  }

  /**
   * The user's own timezone.
   *
   * Not optional and not defaulted silently to UTC at the call site: "tomorrow
   * morning" resolved in the wrong zone returns their mail hours early, and the
   * column has a default so this only falls back for a row that predates it.
   */
  private async timezoneOf(userId: string): Promise<string> {
    const user = await this.prisma.forUser(userId, async (tx) =>
      tx.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    );

    return user?.timezone || 'UTC';
  }
}
