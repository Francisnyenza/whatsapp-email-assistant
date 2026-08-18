/**
 * When a Gmail watch is due for renewal, and how a renewal is identified.
 *
 * Pure, so the arithmetic that decides whether mail keeps flowing can be tested
 * without a database, a queue or a clock.
 */

/**
 * Gmail's `users.watch` lasts seven days. Renewing two days early leaves room
 * for the sweep to fail its retries, for Google to be briefly unavailable, and
 * for a worker to be down for a deploy, all without the subscription lapsing.
 */
export const RENEWAL_HORIZON_HOURS = 48;

/** How often the sweep runs. The job id bucket below assumes this cadence. */
export const SWEEP_INTERVAL_MS = 3_600_000;

/**
 * One sweep's fan-out is capped. A backlog is drained over successive sweeps
 * rather than in one burst that would rate-limit us out of the Gmail API and
 * take the ingest path down with it.
 */
export const SWEEP_BATCH_SIZE = 500;

/**
 * The retention sweep's batching.
 *
 * Two separate bounds, because they guard different things: the user batch
 * keeps the enumeration query small, and the per-user row cap keeps any one
 * transaction short so an enormous mailbox cannot hold a connection for minutes
 * or starve every other user behind it. Whatever is left over is caught by the
 * next run — the retention window only moves forward.
 */
export const PURGE_USER_BATCH = 500;
export const PURGE_ROWS_PER_USER = 1_000;

/** Once a day is ample for a window measured in weeks. */
export const PURGE_INTERVAL_MS = 24 * 3_600_000;

/**
 * Re-exported so the sweep keeps importing its schedule from one place.
 *
 * The value itself lives in `@wea/shared` because the preflight check quotes it
 * to an operator running without push, and two copies would drift.
 */
export { POLL_INTERVAL_MS } from '@wea/shared';

/**
 * Polled per sweep. A cap rather than a limit on how many accounts may use the
 * fallback: an outage that unwatches everyone drains over successive sweeps
 * instead of arriving as one burst against the Gmail API.
 */
export const POLL_BATCH_SIZE = 200;

/**
 * The id under which a renewal is enqueued.
 *
 * De-duplication is the point. The sweep runs hourly and the horizon is two
 * days, so the same account is seen due roughly forty-eight times before its
 * watch actually lapses. Keying on the expiry means all forty-eight collapse
 * into one renewal.
 *
 * An account with no watch has no expiry to key on, so it buckets on the sweep's
 * own tick instead: repeated sweeps within the hour collapse, and the next hour
 * is a fresh attempt. That is what lets an account that failed to establish a
 * watch keep being retried, rather than being attempted once and abandoned.
 *
 * The de-duplication window is bounded by how long BullMQ keeps completed jobs,
 * which is a count rather than a duration. Losing it early costs a redundant
 * renewal, and Gmail's watch is idempotent, so the failure mode is a wasted API
 * call rather than a wrong outcome.
 */
export function renewalJobId(accountId: string, dueAt: Date | null, sweepAt: Date): string {
  const bucket = Math.floor((dueAt ?? sweepAt).getTime() / SWEEP_INTERVAL_MS);
  return `watch:${accountId}:${bucket}`;
}

/**
 * Whether an expiry falls inside the renewal horizon.
 *
 * Mirrors the database predicate the sweep uses, so the two cannot disagree
 * about what "due" means.
 */
export function isDue(
  expiresAt: Date | null,
  now: Date,
  horizonHours = RENEWAL_HORIZON_HOURS,
): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() < now.getTime() + horizonHours * 3_600_000;
}
