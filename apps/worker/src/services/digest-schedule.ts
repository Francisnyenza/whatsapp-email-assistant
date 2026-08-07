/**
 * When a user's scheduled digest is due.
 *
 * Pure, because every bug this could have is a timezone bug and those are worth
 * testing without a database in the way. The user picks times like `08:00` and
 * means them in their own timezone — a digest that arrives at 08:00 UTC for
 * someone in Nairobi is three hours late and reads as broken.
 */

/**
 * How often the sweep runs. Digest times have minute precision, so an hourly
 * tick would silently never fire for anyone who chose `08:30`.
 */
export const DIGEST_SWEEP_INTERVAL_MS = 15 * 60_000;

/** Users examined per sweep batch. */
export const DIGEST_USER_BATCH = 500;

/**
 * Whether a scheduled digest is due.
 *
 * A time is due when the user's local clock has passed it and we have not sent
 * a digest since. `lastDigestAt` is what stops the sweep re-sending at every
 * tick — the backlog alone is not enough, because mail arriving a minute after
 * the 08:00 digest would otherwise trigger another one fifteen minutes later
 * rather than waiting for 18:00.
 *
 * @param times `HH:MM` in the user's own timezone. Malformed entries are
 *   skipped rather than throwing: a bad preference should cost that one time,
 *   not every digest the user was ever going to get.
 */
export function isDigestDue(input: {
  times: string[];
  timezone: string;
  lastDigestAt: Date | null;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  const local = localMinutes(now, input.timezone);
  if (local === null) return false;

  const lastLocal = input.lastDigestAt ? localMinutes(input.lastDigestAt, input.timezone) : null;
  const sameDay =
    input.lastDigestAt !== null && isSameLocalDay(input.lastDigestAt, now, input.timezone);

  for (const time of input.times) {
    const scheduled = parseTime(time);
    if (scheduled === null) continue;

    // Not yet this time today.
    if (local < scheduled) continue;

    // Already sent at or after this time today.
    if (sameDay && lastLocal !== null && lastLocal >= scheduled) continue;

    return true;
  }

  return false;
}

/** Minutes past local midnight, or null when the timezone is not one Intl knows. */
function localMinutes(at: Date, timezone: string): number | null {
  const parts = formatIn(at, timezone);
  if (!parts) return null;
  return parts.hour * 60 + parts.minute;
}

function isSameLocalDay(a: Date, b: Date, timezone: string): boolean {
  const left = formatIn(a, timezone);
  const right = formatIn(b, timezone);
  if (!left || !right) return false;
  return left.day === right.day && left.month === right.month && left.year === right.year;
}

function formatIn(
  at: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);

    return {
      year: value('year'),
      month: value('month'),
      day: value('day'),
      // `hour12: false` still yields 24 for midnight in some ICU versions.
      hour: value('hour') % 24,
      minute: value('minute'),
    };
  } catch {
    // An unknown timezone is a corrupt preference, not a reason to throw inside
    // a sweep that is iterating every user.
    return null;
  }
}

function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;

  return hour * 60 + minute;
}
