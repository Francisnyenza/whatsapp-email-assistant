import { describe, it, expect } from 'vitest';
import { parseSnoozeTime, MIN_SNOOZE_MS } from '../src/services/snooze-time.js';

/**
 * When "until Monday" is.
 *
 * Every assertion here is a timezone assertion in disguise. The user says
 * "tomorrow morning" and means their own morning, and a snooze that returns
 * their mail three hours early — or, worse, immediately — is indistinguishable
 * from the command not having worked.
 *
 * Nairobi (UTC+3, no DST) and New York (UTC-5/-4, DST) are used deliberately:
 * one where the offset is constant and one where it is not.
 */

const NAIROBI = 'Africa/Nairobi';
const NEW_YORK = 'America/New_York';

/** Monday 2026-08-17, 09:00 UTC — noon in Nairobi, 05:00 in New York. */
const NOW = new Date('2026-08-17T09:00:00Z');

const at = (text: string, timezone = NAIROBI, now = NOW) =>
  parseSnoozeTime(text, { now, timezone });

describe('a relative delay', () => {
  it('takes hours and minutes literally', () => {
    expect(at('2 hours')!.at.toISOString()).toBe('2026-08-17T11:00:00.000Z');
    expect(at('30 minutes')!.at.toISOString()).toBe('2026-08-17T09:30:00.000Z');
  });

  it('takes days and weeks', () => {
    expect(at('3 days')!.at.toISOString()).toBe('2026-08-20T09:00:00.000Z');
    expect(at('a week')!.at.toISOString()).toBe('2026-08-24T09:00:00.000Z');
  });

  it('needs no timezone at all, because a delay is not a wall-clock time', () => {
    expect(at('2 hours', NEW_YORK)!.at.toISOString()).toBe('2026-08-17T11:00:00.000Z');
  });

  it('says it back in the same terms the user used', () => {
    expect(at('2 hours')!.description).toBe('in 2 hours');
    expect(at('1 hour')!.description).toBe('in 1 hour');
  });
});

describe('a named day', () => {
  it('puts "tomorrow" at the user’s own morning', () => {
    // 08:00 Tuesday in Nairobi is 05:00 UTC.
    expect(at('tomorrow')!.at.toISOString()).toBe('2026-08-18T05:00:00.000Z');
  });

  it('puts the same words at a different instant elsewhere', () => {
    // 08:00 Tuesday in New York (EDT, UTC-4) is 12:00 UTC. This is the whole
    // reason the user's timezone is carried this far down.
    expect(at('tomorrow', NEW_YORK)!.at.toISOString()).toBe('2026-08-18T12:00:00.000Z');
  });

  it('understands parts of the day', () => {
    expect(at('tomorrow morning')!.at.toISOString()).toBe('2026-08-18T05:00:00.000Z');
    expect(at('tomorrow afternoon')!.at.toISOString()).toBe('2026-08-18T10:00:00.000Z');
    expect(at('tomorrow evening')!.at.toISOString()).toBe('2026-08-18T15:00:00.000Z');
  });

  it('takes an explicit time on a named day', () => {
    // 18:30 Tuesday in Nairobi.
    expect(at('tomorrow at 6:30pm')!.at.toISOString()).toBe('2026-08-18T15:30:00.000Z');
  });

  it('reads a weekday as the next one, never today', () => {
    // NOW is a Monday. "until Monday" means the Monday coming.
    expect(at('monday')!.at.toISOString()).toBe('2026-08-24T05:00:00.000Z');
    expect(at('friday')!.at.toISOString()).toBe('2026-08-21T05:00:00.000Z');
  });

  it('takes short weekday names', () => {
    expect(at('fri')!.at.toISOString()).toBe(at('friday')!.at.toISOString());
  });

  it('reads "next week" as seven days out, at the morning hour', () => {
    expect(at('next week')!.at.toISOString()).toBe('2026-08-24T05:00:00.000Z');
  });

  it('reads "next friday" as the one after this week’s', () => {
    expect(at('next friday')!.at.toISOString()).toBe('2026-08-28T05:00:00.000Z');
  });
});

describe('a bare clock time', () => {
  it('means today when it is still ahead', () => {
    // 15:00 in Nairobi is 12:00 UTC, three hours after NOW.
    expect(at('3pm')!.at.toISOString()).toBe('2026-08-17T12:00:00.000Z');
  });

  it('means tomorrow when it has already gone', () => {
    // 09:00 Nairobi was three hours ago. Firing then would be indistinguishable
    // from the command having failed.
    expect(at('9am')!.at.toISOString()).toBe('2026-08-18T06:00:00.000Z');
  });

  it('takes a 24-hour clock', () => {
    expect(at('17:30')!.at.toISOString()).toBe('2026-08-17T14:30:00.000Z');
  });

  it('reads midnight as the start of the day, not noon', () => {
    expect(at('12am')!.at.toISOString()).toBe('2026-08-17T21:00:00.000Z');
  });
});

describe('across a daylight-saving change', () => {
  it('lands on the wall-clock time the user asked for, not one hour off', () => {
    // New York leaves EDT at 02:00 on 2026-11-01. A snooze set on the Friday
    // before, for "monday", must return at 08:00 EST — 13:00 UTC — and not at
    // 12:00 UTC, which is what measuring the offset at `now` would produce.
    const friday = new Date('2026-10-30T14:00:00Z');

    const result = parseSnoozeTime('monday', { now: friday, timezone: NEW_YORK });

    expect(result!.at.toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });
});

describe('what it refuses', () => {
  it('returns null rather than guessing at nonsense', () => {
    // A wrong guess loses the message until the user goes looking for it.
    for (const text of ['soon', 'later', 'whenever', 'the invoice', '']) {
      expect(at(text)).toBeNull();
    }
  });

  it('refuses a time that is already past', () => {
    expect(at('0 minutes')).toBeNull();
  });

  it('refuses something absurdly far out', () => {
    expect(at('500 days')).toBeNull();
  });

  it('refuses an hour that is not one', () => {
    expect(at('25:00')).toBeNull();
    expect(at('at 99')).toBeNull();
  });

  it('refuses a timezone Intl does not know, rather than throwing', () => {
    expect(at('tomorrow', 'Mars/Olympus')).toBeNull();
  });

  it('refuses anything under a minute away', () => {
    const result = at('1 minute');
    expect(result!.at.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(MIN_SNOOZE_MS);
  });
});

describe('the words people put in front', () => {
  it('ignores until, till, for, in and at', () => {
    const expected = at('tomorrow')!.at.toISOString();

    for (const text of ['until tomorrow', 'till tomorrow', 'for tomorrow', 'on tomorrow']) {
      expect(at(text)!.at.toISOString()).toBe(expected);
    }
  });
});
