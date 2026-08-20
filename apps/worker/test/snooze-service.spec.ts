import { describe, it, expect, vi } from 'vitest';
import { SnoozeService } from '../src/services/snooze.service.js';

/**
 * Putting a message down until later, and the order in which it happens.
 *
 * Snooze is two halves that must not come apart: the message leaves the inbox
 * now, and it comes back at a stated time. The second is what the user is
 * trusting, and a snooze that archives and then forgets is worse than no snooze
 * at all — they have stopped thinking about the message and nothing is coming.
 *
 * So every ordering assertion below is about which half survives a failure.
 */

describe('putting a message down', () => {
  it('remembers it before taking it out of the inbox', async () => {
    // The order that decides the failure mode. Archive-then-remember has a
    // window where the message is gone and nothing is coming for it.
    const { service, order } = build();

    await service.snooze('user-1', 'email-1', 'tomorrow', NOW);

    expect(order).toEqual(['reminder', 'archive']);
  });

  it('resolves the time in the user’s own timezone', async () => {
    const { service, reminders } = build({ timezone: 'Africa/Nairobi' });

    await service.snooze('user-1', 'email-1', 'tomorrow', NOW);

    // 08:00 Tuesday in Nairobi is 05:00 UTC.
    expect(reminders.create.mock.calls[0]![0].remindAt.toISOString()).toBe(
      '2026-08-18T05:00:00.000Z',
    );
  });

  it('says the resolved time back, not the words the user used', async () => {
    // "Until Monday" is not a confirmation. "Monday 24 Aug, 08:00" is, and it is
    // the only version a misreading is visible in.
    const { service } = build();

    const result = await service.snooze('user-1', 'email-1', 'monday', NOW);

    expect(result.description).toMatch(/Monday/);
    expect(result.description).toMatch(/08:00/);
  });

  it('leaves the message in the inbox when the time makes no sense', async () => {
    const { service, reminders, mailbox } = build();

    await expect(service.snooze('user-1', 'email-1', 'whenever', NOW)).rejects.toMatchObject({
      publicMessage: expect.stringContaining('snooze until tomorrow'),
    });

    expect(reminders.create).not.toHaveBeenCalled();
    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('leaves the message in the inbox when the reminder cannot be written', async () => {
    const { service, mailbox } = build({ createFails: true });

    await expect(service.snooze('user-1', 'email-1', 'tomorrow', NOW)).rejects.toThrow();

    // Still visible, which is the harmless way for this to fail.
    expect(mailbox.apply).not.toHaveBeenCalled();
  });
});

describe('bringing it back', () => {
  it('unarchives and notifies, past the user’s notification settings', async () => {
    // They asked for this message at this moment; quiet hours are a rule about
    // mail arriving unbidden.
    const { service, mailbox, queue } = build();

    expect(await service.fire('user-1', 'rem-1', 'email-1')).toBe(true);

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', { kind: 'unarchive' });
    expect(queue.enqueue.mock.calls[0]![2]).toMatchObject({ force: true });
  });

  it('does nothing when another worker claimed it first', async () => {
    const { service, mailbox } = build({ claimed: false });

    expect(await service.fire('user-1', 'rem-1', 'email-1')).toBe(false);
    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('releases the claim when the mailbox refuses, so the next sweep retries', async () => {
    // Otherwise the message stays archived with nothing coming for it — the
    // exact failure snooze exists to avoid.
    const { service, reminders } = build({ applyFails: true });

    await expect(service.fire('user-1', 'rem-1', 'email-1')).rejects.toThrow();

    expect(reminders.release).toHaveBeenCalledWith('user-1', 'rem-1');
  });

  it('keys the notification on the reminder, so a retried sweep sends one', async () => {
    const { service, queue } = build();

    await service.fire('user-1', 'rem-1', 'email-1');

    expect(queue.enqueue.mock.calls[0]![3]).toMatchObject({ jobId: 'notify~reminder~rem-1' });
  });
});

describe('when the user deals with it first', () => {
  it('forgets the snooze', async () => {
    // Bringing back something already replied to is what makes people stop
    // trusting snooze — and they cannot tell it from the feature working.
    const { service, reminders } = build();

    await service.cancelFor('user-1', 'email-1');

    expect(reminders.cancelFor).toHaveBeenCalledWith('user-1', 'email-1');
  });
});

/* --------------------------------- helpers -------------------------------- */

/** Monday 2026-08-17, 09:00 UTC. */
const NOW = new Date('2026-08-17T09:00:00Z');

function build(
  input: {
    timezone?: string;
    claimed?: boolean;
    applyFails?: boolean;
    createFails?: boolean;
  } = {},
) {
  const order: string[] = [];

  const reminders = {
    create: vi.fn(async () => {
      if (input.createFails) throw new Error('could not write the reminder');
      order.push('reminder');
      return { id: 'rem-1' };
    }),
    claim: vi.fn(async () => input.claimed !== false),
    release: vi.fn(async () => undefined),
    cancelFor: vi.fn(async () => 1),
  };

  const mailbox = {
    apply: vi.fn(async () => {
      if (input.applyFails) throw new Error('provider refused');
      order.push('archive');
    }),
  };

  const queue = { enqueue: vi.fn(async () => undefined) };

  const prisma = {
    forUser: async <T>(_u: string, fn: (tx: unknown) => Promise<T>) =>
      fn({
        user: { findUnique: async () => ({ timezone: input.timezone ?? 'Africa/Nairobi' }) },
      }),
  };

  const service = new SnoozeService(
    prisma as never,
    mailbox as never,
    reminders as never,
    queue as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );

  return { service, reminders, mailbox, queue, order };
}
