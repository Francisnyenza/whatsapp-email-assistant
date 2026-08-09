import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError, JOB } from '@wea/shared';
import { SyncProcessor } from '../src/processors/sync.processor.js';
import {
  isDue,
  renewalJobId,
  RENEWAL_HORIZON_HOURS,
  SWEEP_INTERVAL_MS,
} from '../src/services/watch-schedule.js';

/**
 * Keeping mailboxes subscribed.
 *
 * A lapsed Gmail watch produces no error anywhere — pushes simply stop and the
 * user's mail stops arriving. There is nothing to observe when this breaks, so
 * the behaviour is pinned here instead.
 */

const HOUR = 3_600_000;
const now = new Date('2026-08-06T12:00:00Z');

describe('when a watch is due', () => {
  it('treats no watch at all as due', () => {
    // An account on the polling fallback. It is receiving nothing right now,
    // which makes it more urgent than one whose watch expires on Friday.
    expect(isDue(null, now)).toBe(true);
  });

  it('is due inside the horizon', () => {
    expect(isDue(new Date(now.getTime() + 47 * HOUR), now)).toBe(true);
  });

  it('is not due outside it', () => {
    expect(isDue(new Date(now.getTime() + 49 * HOUR), now)).toBe(false);
  });

  it('is due once already expired', () => {
    expect(isDue(new Date(now.getTime() - HOUR), now)).toBe(true);
  });

  it('renews with days to spare', () => {
    // Gmail's watch lasts seven days. The horizon has to leave room for the
    // sweep to fail its retries and for a worker to be down for a deploy.
    expect(RENEWAL_HORIZON_HOURS).toBeGreaterThanOrEqual(24);
    expect(RENEWAL_HORIZON_HOURS).toBeLessThan(7 * 24);
  });
});

describe('the renewal job id', () => {
  it('is the same across sweeps for one lapsing watch', () => {
    // The sweep runs hourly and the horizon is two days, so the same account is
    // seen due dozens of times. All of them must collapse into one renewal.
    const dueAt = new Date(now.getTime() + 30 * HOUR);

    const first = renewalJobId('acct-1', dueAt, now);
    const second = renewalJobId('acct-1', dueAt, new Date(now.getTime() + 5 * HOUR));

    expect(first).toBe(second);
  });

  it('differs between accounts', () => {
    const dueAt = new Date(now.getTime() + 30 * HOUR);
    expect(renewalJobId('acct-1', dueAt, now)).not.toBe(renewalJobId('acct-2', dueAt, now));
  });

  it('changes each hour for an account with no watch', () => {
    // Without this an account that failed to establish a watch would be
    // attempted once and then never again, because the job id would never
    // change and every later add would be de-duplicated away.
    const first = renewalJobId('acct-1', null, now);
    const later = renewalJobId('acct-1', null, new Date(now.getTime() + SWEEP_INTERVAL_MS));

    expect(first).not.toBe(later);
  });

  it('collapses repeated sweeps within the hour for an account with no watch', () => {
    const first = renewalJobId('acct-1', null, now);
    const soon = renewalJobId('acct-1', null, new Date(now.getTime() + 60_000));

    expect(first).toBe(soon);
  });
});

describe('the sync processor', () => {
  let processor: SyncProcessor;
  let watches: {
    findDue: ReturnType<typeof vi.fn>;
    findWithoutWatch: ReturnType<typeof vi.fn>;
    recordRenewed: ReturnType<typeof vi.fn>;
    recordUnavailable: ReturnType<typeof vi.fn>;
    recordRenewalFailure: ReturnType<typeof vi.fn>;
    dropRoute: ReturnType<typeof vi.fn>;
  };
  let accounts: {
    load: ReturnType<typeof vi.fn>;
    providerFor: ReturnType<typeof vi.fn>;
    markReauthRequired: ReturnType<typeof vi.fn>;
  };
  let renewWatch: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;
  let logger: any;

  const handle = {
    subscriptionId: 'projects/p/topics/t',
    expiresAt: new Date(now.getTime() + 7 * 24 * HOUR),
    cursor: { value: '99999' },
  };

  beforeEach(() => {
    watches = {
      findDue: vi.fn().mockResolvedValue([]),
      findWithoutWatch: vi.fn().mockResolvedValue([]),
      recordRenewed: vi.fn().mockResolvedValue(undefined),
      recordUnavailable: vi.fn().mockResolvedValue(undefined),
      recordRenewalFailure: vi.fn().mockResolvedValue(undefined),
      dropRoute: vi.fn().mockResolvedValue(undefined),
    };
    renewWatch = vi.fn().mockResolvedValue(handle);
    accounts = {
      load: vi.fn().mockResolvedValue({ id: 'acct-1', userId: 'user-1' }),
      providerFor: vi.fn().mockReturnValue({ renewWatch }),
      markReauthRequired: vi.fn().mockResolvedValue(undefined),
    };
    enqueue = vi.fn().mockResolvedValue(undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    processor = new SyncProcessor(
      { env: { RETENTION_BODY_DAYS: 30 } } as never,
      accounts as never,
      watches as never,
      // The retention sweep has its own spec against a real database; here it
      // only needs to exist so the constructor's shape is honest.
      { findUserIds: vi.fn().mockResolvedValue([]), purgeBodies: vi.fn() } as never,
      // Likewise the backfill sweep — its own spec, against a real database.
      {
        findUsersNeedingBackfill: vi.fn().mockResolvedValue([]),
        findUnembedded: vi.fn(),
        markBackfilled: vi.fn(),
      } as never,
      { isOverBudget: vi.fn().mockResolvedValue(false) } as never,
      { enqueue } as never,
      logger,
    );
  });

  const run = (name: string, data: unknown) => processor.handle({ name, data } as never);
  const sweep = () => run(JOB.SWEEP_WATCHES, {});
  const renew = (over: Record<string, unknown> = {}) =>
    run(JOB.RENEW_WATCH, { userId: 'user-1', accountId: 'acct-1', dueAt: null, ...over });

  describe('the sweep', () => {
    it('enqueues one renewal per due account', async () => {
      watches.findDue.mockResolvedValue([
        { userId: 'user-1', accountId: 'acct-1', expiresAt: new Date(now.getTime() + 10 * HOUR) },
        { userId: 'user-2', accountId: 'acct-2', expiresAt: null },
      ]);

      await sweep();

      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue.mock.calls[0]![2]).toMatchObject({ userId: 'user-1', accountId: 'acct-1' });
      expect(enqueue.mock.calls[1]![2]).toMatchObject({ userId: 'user-2', accountId: 'acct-2' });
    });

    it('gives every renewal a de-duplicating job id', async () => {
      watches.findDue.mockResolvedValue([
        { userId: 'user-1', accountId: 'acct-1', expiresAt: new Date(now.getTime() + 10 * HOUR) },
      ]);

      await sweep();

      expect(enqueue.mock.calls[0]![3]).toMatchObject({ jobId: expect.stringMatching(/^watch:/) });
    });

    it('caps the fan-out', async () => {
      // A backlog after an outage must drain over successive sweeps, not arrive
      // as one burst that rate-limits us out of the Gmail API.
      await sweep();
      const [, limit] = watches.findDue.mock.calls[0]!;
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(1_000);
    });

    it('honours an operator-supplied horizon', async () => {
      await run(JOB.SWEEP_WATCHES, { horizonHours: 1 });
      expect(watches.findDue.mock.calls[0]![0]).toBe(1);
    });

    it('does nothing when nothing is due', async () => {
      await sweep();
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('the renewal', () => {
    it('re-issues the watch and records the new expiry', async () => {
      await renew();

      expect(renewWatch).toHaveBeenCalledOnce();
      expect(watches.recordRenewed).toHaveBeenCalledWith(
        'user-1',
        'acct-1',
        handle.expiresAt,
        '99999',
        handle.subscriptionId,
      );
    });

    it('carries a changed subscription id through', async () => {
      // Graph's renewal can return a *different* id: a PATCH that found the old
      // subscription gone falls back to creating one. The id has to move with
      // it, or the next renewal PATCHes something that no longer exists.
      renewWatch.mockResolvedValue({ ...handle, subscriptionId: 'sub-2' });

      await renew();

      expect(watches.recordRenewed).toHaveBeenCalledWith(
        'user-1',
        'acct-1',
        handle.expiresAt,
        '99999',
        'sub-2',
      );
    });

    it('records none when the provider issues none, as Gmail does', async () => {
      const { subscriptionId: _none, ...withoutSubscription } = handle;
      renewWatch.mockResolvedValue(withoutSubscription);

      await renew();

      expect(watches.recordRenewed).toHaveBeenCalledWith(
        'user-1',
        'acct-1',
        handle.expiresAt,
        '99999',
        undefined,
      );
    });

    it('drops the route for an account that no longer exists', async () => {
      accounts.load.mockRejectedValue(new AppError('NOT_FOUND', 'gone'));

      await renew();

      expect(watches.dropRoute).toHaveBeenCalledWith('acct-1');
      expect(renewWatch).not.toHaveBeenCalled();
    });

    it('drops the route when the grant is gone', async () => {
      // Otherwise every sweep re-attempts a mailbox nobody can renew until the
      // user reconnects — and reconnecting re-creates the route anyway.
      accounts.load.mockRejectedValue(new AppError('PROVIDER_UNAUTHORIZED', 'revoked'));

      await renew();

      expect(watches.dropRoute).toHaveBeenCalledWith('acct-1');
    });

    it('does not swallow an unexpected failure to load the account', async () => {
      accounts.load.mockRejectedValue(new AppError('INTERNAL', 'database down'));

      await expect(renew()).rejects.toThrow();
      expect(watches.dropRoute).not.toHaveBeenCalled();
    });

    it('marks the account for reconnection when Google rejects the grant', async () => {
      renewWatch.mockRejectedValue(new AppError('PROVIDER_UNAUTHORIZED', 'invalid_grant'));

      await renew();

      expect(accounts.markReauthRequired).toHaveBeenCalledWith(
        'user-1',
        'acct-1',
        'PROVIDER_UNAUTHORIZED',
      );
      expect(watches.dropRoute).toHaveBeenCalledWith('acct-1');
    });

    it('falls back to polling when Pub/Sub is misconfigured, without retrying', async () => {
      // One operator mistake would otherwise land in the dead letter queue once
      // per account per hour.
      renewWatch.mockRejectedValue(new AppError('DEPENDENCY_UNAVAILABLE', 'no topic'));

      await expect(renew()).resolves.toBeUndefined();

      expect(watches.recordUnavailable).toHaveBeenCalledWith(
        'user-1',
        'acct-1',
        'DEPENDENCY_UNAVAILABLE',
      );
      expect(logger.error).toHaveBeenCalled();
    });

    it('retries a transient failure', async () => {
      renewWatch.mockRejectedValue(new AppError('PROVIDER_RATE_LIMITED', 'slow down'));

      await expect(renew()).rejects.toThrow();
    });

    it('leaves the expiry alone on a transient failure', async () => {
      // A timeout says nothing about when the subscription lapses. Rewriting the
      // expiry would replace a true record with a guess, and would tell the
      // sweep this account has no watch when it still does.
      renewWatch.mockRejectedValue(new AppError('PROVIDER_RATE_LIMITED', 'slow down'));

      await renew().catch(() => undefined);

      expect(watches.recordUnavailable).not.toHaveBeenCalled();
      expect(watches.recordRenewalFailure).toHaveBeenCalledWith(
        'user-1',
        'acct-1',
        'PROVIDER_RATE_LIMITED',
      );
    });
  });

  describe('the polling fallback', () => {
    const poll = () => run(JOB.SWEEP_POLLING, {});

    it('syncs a mailbox that has no push subscription', async () => {
      // Otherwise "we could not set up a watch" means "you receive nothing".
      watches.findWithoutWatch.mockResolvedValue([
        { userId: 'user-1', accountId: 'acct-1', expiresAt: null },
      ]);

      await poll();

      expect(enqueue).toHaveBeenCalledWith(
        'ingest',
        'ingest.processChange',
        expect.objectContaining({ userId: 'user-1', accountId: 'acct-1' }),
        expect.objectContaining({ jobId: expect.stringMatching(/^poll:acct-1:/) }),
      );
    });

    it('collapses overlapping sweeps into one sync per account', async () => {
      watches.findWithoutWatch.mockResolvedValue([
        { userId: 'user-1', accountId: 'acct-1', expiresAt: null },
      ]);

      await poll();
      await poll();

      const ids = enqueue.mock.calls.map((call) => call[3].jobId);
      expect(new Set(ids).size).toBe(1);
    });

    it('polls every unwatched account, not just the first', async () => {
      watches.findWithoutWatch.mockResolvedValue([
        { userId: 'user-1', accountId: 'acct-1', expiresAt: null },
        { userId: 'user-2', accountId: 'acct-2', expiresAt: null },
      ]);

      await poll();

      expect(enqueue).toHaveBeenCalledTimes(2);
    });

    it('caps the batch, so an outage does not become a burst', async () => {
      await poll();

      const [limit] = watches.findWithoutWatch.mock.calls[0]!;
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(1_000);
    });

    it('does nothing when every mailbox is on push', async () => {
      await poll();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('leaves the cursor to ingest rather than inventing one', async () => {
      // Ingest resumes from what it stored. A cursor supplied here would be the
      // exact bug that made the push path inert.
      watches.findWithoutWatch.mockResolvedValue([
        { userId: 'user-1', accountId: 'acct-1', expiresAt: null },
      ]);

      await poll();

      expect(enqueue.mock.calls[0]![2].cursor).toBe('poll');
    });
  });

  it('dead-letters an unknown job rather than retrying it', async () => {
    // It will still be unknown on the fourth attempt.
    await expect(run('sync.somethingElse', {})).rejects.toMatchObject({ retryable: false });
  });
});
