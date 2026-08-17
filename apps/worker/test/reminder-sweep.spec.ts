import { describe, it, expect, vi } from 'vitest';
import { JOB } from '@wea/shared';
import { SyncProcessor } from '../src/processors/sync.processor.js';

/**
 * The sweep that brings snoozed mail back.
 *
 * `JOB.CHECK_REMINDERS` was declared in the shared constants and the `reminders`
 * table carried an index whose comment reads "drives the due-reminder sweep".
 * Neither had a producer or a consumer for the life of the project, which meant
 * a snooze — had one been reachable — would have archived the message and
 * forgotten it.
 *
 * The shape is the digest sweep's, and for the same reason: `reminders` is under
 * row-level security, so a timer with no tenant cannot ask across users. It
 * enumerates ids from `users`, which carries no policy, and asks once per user.
 */

describe('the reminder sweep', () => {
  it('returns every due reminder, for every user', async () => {
    const { processor, fire } = build({
      users: ['user-1', 'user-2'],
      due: {
        'user-1': [{ id: 'rem-1', emailMessageId: 'email-1' }],
        'user-2': [{ id: 'rem-2', emailMessageId: 'email-2' }],
      },
    });

    await processor.handle({ name: JOB.CHECK_REMINDERS, data: {} } as never);

    expect(fire).toHaveBeenCalledWith('user-1', 'rem-1', 'email-1');
    expect(fire).toHaveBeenCalledWith('user-2', 'rem-2', 'email-2');
  });

  it('keeps going when one user’s mailbox refuses', async () => {
    // One provider being down must not stop everyone else's mail coming back.
    const { processor, fire } = build({
      users: ['user-1', 'user-2'],
      due: {
        'user-1': [{ id: 'rem-1', emailMessageId: 'email-1' }],
        'user-2': [{ id: 'rem-2', emailMessageId: 'email-2' }],
      },
      failFor: 'user-1',
    });

    await expect(
      processor.handle({ name: JOB.CHECK_REMINDERS, data: {} } as never),
    ).resolves.toBeUndefined();

    expect(fire).toHaveBeenCalledWith('user-2', 'rem-2', 'email-2');
  });

  it('does nothing when nothing is due', async () => {
    const { processor, fire } = build({ users: ['user-1'], due: {} });

    await processor.handle({ name: JOB.CHECK_REMINDERS, data: {} } as never);

    expect(fire).not.toHaveBeenCalled();
  });

  it('walks past the first page of users', async () => {
    // Keyset pagination: a sweep that stopped at the first batch would never
    // return mail for anyone past it.
    const { processor, findUserIds } = build({ users: [], due: {} });

    await processor.handle({ name: JOB.CHECK_REMINDERS, data: {} } as never);

    expect(findUserIds).toHaveBeenCalled();
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(input: {
  users: string[];
  due: Record<string, Array<{ id: string; emailMessageId: string }>>;
  failFor?: string;
}) {
  const findUserIds = vi.fn(async () => input.users);
  const fire = vi.fn(async (userId: string) => {
    if (userId === input.failFor) throw new Error('provider refused');
    return true;
  });

  const processor = new SyncProcessor(
    { env: {} } as never,
    {} as never,
    {} as never,
    { findUserIds } as never,
    {} as never,
    { findDueFor: async (userId: string) => input.due[userId] ?? [] } as never,
    { fire } as never,
    {} as never,
    { enqueue: vi.fn() } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );

  return { processor, fire, findUserIds };
}
