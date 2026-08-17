/**
 * When "until Monday" is.
 *
 * Pure, and separated from everything that snoozes, because every bug this can
 * have is a timezone bug and those are worth testing without a database in the
 * way. A user who says "tomorrow morning" means their own morning; returning
 * their mail at 08:00 UTC to someone in Nairobi is three hours early and reads
 * as broken.
 *
 * Two rules shape the parsing:
 *
 *  1. **Never resolve to the past.** "at 9am" said at ten in the morning means
 *     tomorrow, not four minutes ago — a snooze that fires immediately is
 *     indistinguishable from the command having failed.
 *  2. **Return null rather than guess.** Everything here is a promise to bring
 *     a message back at a particular moment, and a wrong guess loses it until
 *     the user goes looking. The caller asks again instead.
 */

export interface SnoozeTime {
  at: Date;
  /** How to describe it back, in the user's own local terms. */
  description: string;
}

/** Where "tomorrow" and "Monday" land when no clock time is given. */
export const DEFAULT_MORNING_HOUR = 8;
const AFTERNOON_HOUR = 13;
const EVENING_HOUR = 18;

/** The shortest and longest snooze worth honouring. */
export const MIN_SNOOZE_MS = 60_000;
export const MAX_SNOOZE_DAYS = 365;

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

export function parseSnoozeTime(
  raw: string,
  options: { now: Date; timezone: string },
): SnoozeTime | null {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:until|till|til|to|for|in|at|on)\s+/, '')
    .replace(/\.$/, '');

  if (!text) return null;

  const { now, timezone } = options;

  const relative = parseRelative(text, now);
  if (relative) return bounded(relative, now);

  const named = parseNamed(text, now, timezone);
  if (named) return bounded(named, now);

  const clock = parseClockOnly(text, now, timezone);
  if (clock) return bounded(clock, now);

  return null;
}

/* -------------------------------- relative -------------------------------- */

/** "2 hours", "30 minutes", "3 days", "an hour", "a week". */
function parseRelative(text: string, now: Date): SnoozeTime | null {
  const match =
    /^(\d{1,4}|an?|one|two|three|four|five|six)\s*(min|minute|hour|hr|day|week)s?$/.exec(text);
  if (!match) return null;

  const words: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  const count = words[match[1]!] ?? Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return null;

  const unit = match[2]!;
  const ms = unit.startsWith('min')
    ? 60_000
    : unit.startsWith('h')
      ? 3_600_000
      : unit === 'day'
        ? 86_400_000
        : 604_800_000;

  const at = new Date(now.getTime() + count * ms);
  const plural = count === 1 ? '' : 's';
  const noun = unit.startsWith('min') ? 'minute' : unit.startsWith('h') ? 'hour' : unit;

  return { at, description: `in ${count} ${noun}${plural}` };
}

/* --------------------------------- named ---------------------------------- */

/**
 * "tomorrow", "tomorrow morning", "tonight", "monday", "next week", and each of
 * those with a clock time attached.
 */
function parseNamed(text: string, now: Date, timezone: string): SnoozeTime | null {
  const local = wallClock(now, timezone);
  if (!local) return null;

  // A trailing clock time overrides the part-of-day default: "tomorrow at 6pm".
  const withTime = /^(.*?)(?:\s+(?:at|by)\s+|\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/.exec(text);
  const head = (withTime?.[1] ?? text).trim();
  const explicit = withTime ? parseClock(withTime[2]!) : null;
  if (withTime && !explicit) return null;

  const partOfDay = partOfDayHour(head);
  const base = partOfDay ? head.replace(partOfDay.phrase, '').trim() : head;
  const hour = explicit?.hour ?? partOfDay?.hour ?? DEFAULT_MORNING_HOUR;
  const minute = explicit?.minute ?? 0;

  const add = daysUntil(base, local.weekday);
  if (add === null) return null;

  const at = instantOf(
    { year: local.year, month: local.month, day: local.day + add, hour, minute },
    timezone,
  );
  if (!at) return null;

  return { at, description: describe(at, timezone) };
}

/**
 * How many local days ahead a name points.
 *
 * `null` means the text is not a day name at all, which is how "gibberish"
 * reaches the caller as a question rather than as tomorrow morning.
 */
function daysUntil(text: string, todayWeekday: number): number | null {
  if (text === '' || text === 'today') return 0;
  if (text === 'tomorrow' || text === 'tmr' || text === 'tmw') return 1;
  if (text === 'next week') return 7;
  if (text === 'next month') return 30;

  const nextPrefixed = /^next\s+(.+)$/.exec(text);
  const name = nextPrefixed?.[1] ?? text;

  const weekday = WEEKDAYS[name];
  if (weekday === undefined) return null;

  // The next one that is not today: "until Monday" said on a Monday means the
  // Monday coming, never the one already underway.
  const ahead = (weekday - todayWeekday + 7) % 7 || 7;

  // "next friday" means the one after this coming Friday only when this week
  // still has one left; otherwise the two mean the same day, which is what
  // most people expect and all of them can correct.
  return nextPrefixed && ahead < 7 ? ahead + 7 : ahead;
}

function partOfDayHour(text: string): { phrase: string; hour: number } | null {
  if (text.includes('morning')) return { phrase: 'morning', hour: DEFAULT_MORNING_HOUR };
  if (text.includes('afternoon')) return { phrase: 'afternoon', hour: AFTERNOON_HOUR };
  if (text.includes('evening')) return { phrase: 'evening', hour: EVENING_HOUR };
  if (text.includes('tonight')) return { phrase: 'tonight', hour: EVENING_HOUR };
  return null;
}

/* --------------------------------- clock ---------------------------------- */

/** A bare time: "9am", "17:30". Today when it is still ahead, tomorrow otherwise. */
function parseClockOnly(text: string, now: Date, timezone: string): SnoozeTime | null {
  const clock = parseClock(text);
  if (!clock) return null;

  const local = wallClock(now, timezone);
  if (!local) return null;

  const today = instantOf({ ...local, hour: clock.hour, minute: clock.minute }, timezone);
  if (!today) return null;

  // Already gone today, so they mean tomorrow. Firing four minutes ago would be
  // indistinguishable from the command having failed.
  const at =
    today.getTime() > now.getTime()
      ? today
      : instantOf(
          { ...local, day: local.day + 1, hour: clock.hour, minute: clock.minute },
          timezone,
        );

  return at ? { at, description: describe(at, timezone) } : null;
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim());
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];

  if (!Number.isFinite(hour) || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  // "at 25" is a typo, not one in the morning.
  if (hour > 23) return null;

  return { hour, minute };
}

/* -------------------------------- bounding -------------------------------- */

/**
 * Refuses a time that is already past or absurdly far off.
 *
 * A snooze into the past fires on the next sweep, which the user reads as the
 * command not having worked. One a decade out is a typo nobody would want
 * honoured.
 */
function bounded(time: SnoozeTime, now: Date): SnoozeTime | null {
  const delta = time.at.getTime() - now.getTime();
  if (!Number.isFinite(delta)) return null;
  if (delta < MIN_SNOOZE_MS) return null;
  if (delta > MAX_SNOOZE_DAYS * 86_400_000) return null;
  return time;
}

/* ------------------------------- timezones -------------------------------- */

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** What the user's clock reads at `at`, or null for a timezone Intl rejects. */
function wallClock(at: Date, timezone: string): WallClock | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(at);

    const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = WEEKDAYS[value('weekday').toLowerCase()];
    if (weekday === undefined) return null;

    return {
      year: Number(value('year')),
      month: Number(value('month')),
      day: Number(value('day')),
      // `hour12: false` still yields 24 for midnight in some ICU versions.
      hour: Number(value('hour')) % 24,
      minute: Number(value('minute')),
      weekday,
    };
  } catch {
    // A timezone Intl does not know is a corrupt profile, not a reason to throw
    // inside a command the user is waiting on.
    return null;
  }
}

/**
 * The instant at which the user's clock reads these components.
 *
 * The offset is measured at the target rather than at `now`, which is what makes
 * "tomorrow at 9" correct across a DST change in between. It is still one hour
 * out for a time that falls inside the changed hour itself — the honest fix is a
 * full timezone database, and it is not worth pulling one in for an hour's error
 * on two mornings a year.
 *
 * Day overflow is intentional: `day: 32` is next month, which is what
 * `daysUntil` relies on.
 */
function instantOf(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date | null {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  if (!Number.isFinite(guess)) return null;

  const first = offsetAt(new Date(guess), timezone);
  if (first === null) return null;

  const corrected = new Date(guess - first);
  const second = offsetAt(corrected, timezone);
  if (second === null) return null;

  return second === first ? corrected : new Date(guess - second);
}

/** Milliseconds the zone is ahead of UTC at `at`. */
function offsetAt(at: Date, timezone: string): number | null {
  const local = wallClock(at, timezone);
  if (!local) return null;

  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  // `at` carries seconds the wall clock does not, so they are dropped from both.
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** "Monday at 08:00", in the user's own terms. */
function describe(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);
  } catch {
    return at.toISOString();
  }
}
