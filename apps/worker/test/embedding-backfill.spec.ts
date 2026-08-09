import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JOB } from '@wea/shared';
import { SyncProcessor } from '../src/processors/sync.processor.js';

/**
 * The backfill sweep.
 *
 * This is the one job in the system that can spend real money on mail nobody
 * asked about, so most of what is checked here is restraint: it drips rather
 * than floods, it skips a user whose allowance is gone before doing any work for
 * them, and it stops asking about a mailbox that has nothing left. A sweep that
 * re-examines every user forever is a query cost that only grows.
 *
 * It also queues the *same* job ingest does, with the same id. That is what
 * keeps there from being two embedding paths, only one of which gets the budget
 * check and the tenant-scoped write right.
 */

describe('embedding backfill', () => {
  let processor: SyncProcessor;
  let findUsersNeedingBackfill: ReturnType<typeof vi.fn>;
  let findUnembedded: ReturnType<typeof vi.fn>;
  let markBackfilled: ReturnType<typeof vi.fn>;
  let isOverBudget: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let logger: any;
  let days: number;

  beforeEach(() => {
    findUsersNeedingBackfill = vi.fn().mockResolvedValue([]);
    findUnembedded = vi.fn().mockResolvedValue([]);
    markBackfilled = vi.fn().mockResolvedValue(undefined);
    isOverBudget = vi.fn().mockResolvedValue(false);
    enqueue = vi.fn().mockResolvedValue(undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    days = 365;

    processor = new SyncProcessor(
      {
        env: {
          get EMBEDDING_BACKFILL_DAYS() {
            return days;
          },
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { findUsersNeedingBackfill, findUnembedded, markBackfilled } as never,
      { isOverBudget } as never,
      { enqueue } as never,
      logger,
    );
  });

  const sweep = () => processor.handle({ name: JOB.SWEEP_EMBEDDINGS, data: {} } as never);

  const embedJobs = () => enqueue.mock.calls.filter((call) => call[1] === JOB.EMBED_EMAIL);

  /** One page of users, then nothing — the shape the keyset loop expects. */
  const users = (...ids: string[]) => {
    findUsersNeedingBackfill.mockResolvedValueOnce(ids).mockResolvedValue([]);
  };

  it('queues the same job ingest does, with the same id', async () => {
    // Two embedding paths would mean two places to get the budget check and the
    // tenant-scoped write right, and one of them would rot.
    users('user-1');
    findUnembedded.mockResolvedValue(['email-1', 'email-2']);

    await sweep();

    expect(embedJobs()).toHaveLength(2);
    expect(embedJobs()[0]![0]).toBe('ai');
    expect(embedJobs()[0]![2]).toEqual({ userId: 'user-1', emailMessageId: 'email-1' });
    expect(embedJobs()[0]![3]).toMatchObject({ jobId: 'embed:email-1' });
  });

  it('marks a user done when there is nothing left', async () => {
    // Without this the sweep asks the same question of the same mailbox on
    // every run, forever, and gets slower as the product succeeds.
    users('user-1');
    findUnembedded.mockResolvedValue([]);

    await sweep();

    expect(markBackfilled).toHaveBeenCalledWith('user-1');
    expect(embedJobs()).toHaveLength(0);
  });

  it('does not mark a user done while work remains', async () => {
    users('user-1');
    findUnembedded.mockResolvedValue(['email-1']);

    await sweep();

    expect(markBackfilled).not.toHaveBeenCalled();
  });

  it('skips an over-budget user before doing any work for them', async () => {
    // One query instead of fifty jobs that each wake up and decline.
    users('user-1');
    isOverBudget.mockResolvedValue(true);

    await sweep();

    expect(findUnembedded).not.toHaveBeenCalled();
    expect(embedJobs()).toHaveLength(0);
  });

  it('does not mark an over-budget user done', async () => {
    // They still have mail to embed; they just cannot afford it today.
    users('user-1');
    isOverBudget.mockResolvedValue(true);

    await sweep();

    expect(markBackfilled).not.toHaveBeenCalled();
  });

  it('one user being over budget does not stop the next', async () => {
    users('user-1', 'user-2');
    isOverBudget.mockImplementation(async (id: string) => id === 'user-1');
    findUnembedded.mockResolvedValue(['email-2']);

    await sweep();

    expect(findUnembedded).toHaveBeenCalledTimes(1);
    expect(embedJobs()[0]![2]).toMatchObject({ userId: 'user-2' });
  });

  it('walks pages with a keyset cursor, so a slow sweep cannot skip a user', async () => {
    const page = Array.from({ length: 200 }, (_, i) => `user-${String(i).padStart(3, '0')}`);
    findUsersNeedingBackfill
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(['user-200'])
      .mockResolvedValue([]);

    await sweep();

    expect(findUsersNeedingBackfill.mock.calls[1]![1]).toBe('user-199');
    expect(markBackfilled).toHaveBeenCalledTimes(201);
  });

  it('stops paging on a short page rather than making one more round trip', async () => {
    users('user-1');

    await sweep();

    expect(findUsersNeedingBackfill).toHaveBeenCalledTimes(1);
  });

  it('bounds how far back it walks', async () => {
    users('user-1');

    await sweep();

    const since = findUnembedded.mock.calls[0]![2] as Date;
    const age = (Date.now() - since.getTime()) / (24 * 3_600_000);
    expect(age).toBeGreaterThan(364);
    expect(age).toBeLessThan(366);
  });

  it('does nothing at all when the window is zero', async () => {
    // The off switch. An operator who does not want to pay for history says so
    // with a number rather than by deleting a scheduler entry.
    days = 0;
    users('user-1');

    await sweep();

    expect(findUsersNeedingBackfill).not.toHaveBeenCalled();
    expect(embedJobs()).toHaveLength(0);
  });

  it('reports what it did, because a silent sweep is indistinguishable from none', async () => {
    users('user-1', 'user-2');
    findUnembedded.mockResolvedValueOnce(['email-1']).mockResolvedValue([]);

    await sweep();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'sync.backfill_sweep_completed',
        examined: 2,
        queued: 1,
        completed: 1,
      }),
      expect.anything(),
    );
  });
});
