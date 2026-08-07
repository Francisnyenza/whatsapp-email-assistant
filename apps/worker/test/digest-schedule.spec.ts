import { describe, it, expect } from 'vitest';
import { isDigestDue, DIGEST_SWEEP_INTERVAL_MS } from '../src/services/digest-schedule.js';

/**
 * When a scheduled digest is due.
 *
 * Every bug this can have is a timezone bug. A user picks `08:00` and means it
 * in their own morning; a digest that fires at 08:00 UTC reaches Nairobi at
 * 11:00 and reads as broken. And without the last-sent check the sweep re-sends
 * at every tick, which reads as spam.
 */

const nairobi = 'Africa/Nairobi'; // UTC+3, no DST
const utc = 'UTC';

/** 08:00 in Nairobi is 05:00 UTC. */
const at = (iso: string) => new Date(iso);

describe('the user’s own clock', () => {
  it('fires at their local time, not ours', () => {
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: nairobi,
        lastDigestAt: null,
        now: at('2026-08-06T05:00:00Z'),
      }),
    ).toBe(true);
  });

  it('has not fired an hour before their local time', () => {
    // 07:00 in Nairobi. Firing here is the classic "used UTC" bug.
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: nairobi,
        lastDigestAt: null,
        now: at('2026-08-06T04:00:00Z'),
      }),
    ).toBe(false);
  });

  it('handles a timezone behind UTC', () => {
    // 08:00 in New York is 12:00 UTC in August.
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: 'America/New_York',
        lastDigestAt: null,
        now: at('2026-08-06T12:00:00Z'),
      }),
    ).toBe(true);
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: 'America/New_York',
        lastDigestAt: null,
        now: at('2026-08-06T10:00:00Z'),
      }),
    ).toBe(false);
  });

  it('treats an unknown timezone as not due rather than throwing', () => {
    // A corrupt preference must cost that one user their digest, not take down
    // a sweep that is iterating everyone.
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: 'Mars/Olympus_Mons',
        lastDigestAt: null,
        now: at('2026-08-06T12:00:00Z'),
      }),
    ).toBe(false);
  });
});

describe('not sending twice', () => {
  it('does not fire again after sending at that time today', () => {
    // Without this the sweep re-sends every fifteen minutes for the rest of the
    // day, which is the difference between a digest and spam.
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: utc,
        lastDigestAt: at('2026-08-06T08:05:00Z'),
        now: at('2026-08-06T09:00:00Z'),
      }),
    ).toBe(false);
  });

  it('fires for the evening slot even though the morning one already went', () => {
    expect(
      isDigestDue({
        times: ['08:00', '18:00'],
        timezone: utc,
        lastDigestAt: at('2026-08-06T08:05:00Z'),
        now: at('2026-08-06T18:00:00Z'),
      }),
    ).toBe(true);
  });

  it('fires again the next morning', () => {
    // Yesterday's send must not suppress today's.
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: utc,
        lastDigestAt: at('2026-08-05T08:05:00Z'),
        now: at('2026-08-06T08:00:00Z'),
      }),
    ).toBe(true);
  });

  it('compares days in the user’s timezone, not ours', () => {
    // 23:00 UTC is already the next day in Nairobi. A UTC day comparison would
    // treat this send as "today" and suppress the morning digest.
    expect(
      isDigestDue({
        times: ['08:00'],
        timezone: nairobi,
        lastDigestAt: at('2026-08-05T22:00:00Z'), // 01:00 on the 6th, local
        now: at('2026-08-06T05:00:00Z'), // 08:00 on the 6th, local
      }),
    ).toBe(true);
  });
});

describe('malformed preferences', () => {
  it('skips a bad time rather than losing every other one', () => {
    expect(
      isDigestDue({
        times: ['not a time', '08:00'],
        timezone: utc,
        lastDigestAt: null,
        now: at('2026-08-06T08:00:00Z'),
      }),
    ).toBe(true);
  });

  it('rejects an impossible time', () => {
    expect(
      isDigestDue({
        times: ['25:00', '08:70'],
        timezone: utc,
        lastDigestAt: null,
        now: at('2026-08-06T23:59:00Z'),
      }),
    ).toBe(false);
  });

  it('is never due with no times configured', () => {
    expect(
      isDigestDue({
        times: [],
        timezone: utc,
        lastDigestAt: null,
        now: at('2026-08-06T08:00:00Z'),
      }),
    ).toBe(false);
  });
});

describe('the sweep interval', () => {
  it('is fine enough for a half-past time to ever fire', () => {
    // Hourly ticks would silently never fire for anyone who chose 08:30.
    expect(DIGEST_SWEEP_INTERVAL_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it('catches a time that falls between two ticks', () => {
    // "Due" means the clock has passed it, not that it landed on it exactly.
    expect(
      isDigestDue({
        times: ['08:07'],
        timezone: utc,
        lastDigestAt: null,
        now: at('2026-08-06T08:15:00Z'),
      }),
    ).toBe(true);
  });
});
