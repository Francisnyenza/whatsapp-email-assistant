import { WHATSAPP_LIMITS } from '@wea/shared';

/**
 * The 24-hour customer service window.
 *
 * Meta permits free-form messages only within 24 hours of the user's last
 * inbound message. Outside it, nothing but pre-approved template messages will
 * be delivered — the API accepts the send and then silently drops it, or returns
 * a 131047, depending on the case.
 *
 * This single constraint shapes the entire notification design. Every outbound
 * path asks this module what it is allowed to send *before* it builds a payload,
 * because the answer changes what the payload can be.
 */

export type SendMode =
  /** Free-form: text, interactive buttons, lists, media. */
  | 'free_form'
  /** Window closed: only an approved template, which is billable. */
  | 'template_only';

export interface SessionState {
  /** When the user last messaged us. Null means they never have. */
  lastInboundAt: Date | null;
}

export interface WindowDecision {
  mode: SendMode;
  /** Milliseconds until the window closes; 0 when already closed. */
  remainingMs: number;
  /**
   * True when the window closes soon enough that a queued notification would
   * likely arrive after it — worth sending now rather than batching.
   */
  closingSoon: boolean;
}

/** Below this, treat the window as effectively closed for queued work. */
const CLOSING_SOON_MS = 30 * 60 * 1000;

export function evaluateWindow(state: SessionState, now: Date = new Date()): WindowDecision {
  if (!state.lastInboundAt) {
    return { mode: 'template_only', remainingMs: 0, closingSoon: false };
  }

  const elapsed = now.getTime() - state.lastInboundAt.getTime();

  // A future timestamp means clock skew between our servers and Meta's. Trusting
  // it would extend the window past what Meta will honour, so it is clamped.
  const remainingMs = Math.max(0, WHATSAPP_LIMITS.sessionWindowMs - Math.max(0, elapsed));

  if (remainingMs <= 0) {
    return { mode: 'template_only', remainingMs: 0, closingSoon: false };
  }

  return {
    mode: 'free_form',
    remainingMs,
    closingSoon: remainingMs <= CLOSING_SOON_MS,
  };
}

export function isWindowOpen(state: SessionState, now: Date = new Date()): boolean {
  return evaluateWindow(state, now).mode === 'free_form';
}

/* ------------------------------ delivery policy ----------------------------- */

export type NotificationMode = 'instant' | 'digest' | 'priority_only' | 'off';
export type EmailPriority = 'urgent' | 'high' | 'normal' | 'low';

export interface DeliveryPreferences {
  mode: NotificationMode;
  minimumPriority: EmailPriority;
  quietHoursEnabled: boolean;
  /** 'HH:mm' in the user's timezone. */
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string;
  mutedCategories: string[];
  mutedSenders: string[];
}

export interface DeliveryCandidate {
  priority: EmailPriority;
  category: string;
  fromAddress: string;
}

export type DeliveryAction =
  /** Send now, free-form. */
  | { action: 'send_now' }
  /** Send now as a billable template, because the window is closed. */
  | { action: 'send_template'; reason: 'window_closed' }
  /** Hold for the next digest. */
  | { action: 'defer'; reason: 'digest_mode' | 'quiet_hours' | 'window_closed' }
  /** Do not notify at all. */
  | { action: 'suppress'; reason: 'muted_category' | 'muted_sender' | 'below_priority' | 'off' };

const PRIORITY_RANK: Record<EmailPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/**
 * Decides what to do with one email, given the user's preferences and the state
 * of the messaging window.
 *
 * Order matters and is deliberate: suppression is evaluated before anything
 * else, so a muted newsletter never costs a template send. Urgency overrides
 * quiet hours but never overrides an explicit mute — the user asking not to hear
 * from a sender outranks our opinion of how important the message is.
 */
export function decideDelivery(
  candidate: DeliveryCandidate,
  prefs: DeliveryPreferences,
  window: WindowDecision,
  now: Date = new Date(),
): DeliveryAction {
  if (prefs.mode === 'off') return { action: 'suppress', reason: 'off' };

  if (prefs.mutedSenders.some((s) => matchesSender(candidate.fromAddress, s))) {
    return { action: 'suppress', reason: 'muted_sender' };
  }
  if (prefs.mutedCategories.includes(candidate.category)) {
    return { action: 'suppress', reason: 'muted_category' };
  }

  if (
    prefs.mode === 'priority_only' &&
    PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[prefs.minimumPriority]
  ) {
    return { action: 'suppress', reason: 'below_priority' };
  }

  if (prefs.mode === 'digest') return { action: 'defer', reason: 'digest_mode' };

  const urgent = candidate.priority === 'urgent';

  if (prefs.quietHoursEnabled && !urgent && inQuietHours(now, prefs)) {
    return { action: 'defer', reason: 'quiet_hours' };
  }

  if (window.mode === 'free_form') return { action: 'send_now' };

  // Window closed. A template send costs money, so it is reserved for mail the
  // user has said they want immediately; everything else waits for the digest,
  // which they will receive when they next message us.
  if (urgent || candidate.priority === 'high') {
    return { action: 'send_template', reason: 'window_closed' };
  }
  return { action: 'defer', reason: 'window_closed' };
}

/** `sender` matches a mute entry that is either an address or a bare domain. */
function matchesSender(address: string, muted: string): boolean {
  const a = address.trim().toLowerCase();
  const m = muted.trim().toLowerCase();
  if (!m) return false;
  if (m.startsWith('@')) return a.endsWith(m);
  return a === m;
}

/**
 * Quiet hours in the user's own timezone, correctly handling a range that
 * crosses midnight (22:00–07:00 is the default, and is the common case).
 */
export function inQuietHours(now: Date, prefs: DeliveryPreferences): boolean {
  const minutes = minutesOfDayInZone(now, prefs.timezone);
  const start = parseHhMm(prefs.quietHoursStart);
  const end = parseHhMm(prefs.quietHoursEnd);

  if (start === null || end === null) return false;
  if (start === end) return false;

  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end; // crosses midnight
}

function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

function minutesOfDayInZone(date: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);

    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    // 'en-GB' renders midnight as 24 in some ICU versions.
    return (hour % 24) * 60 + minute;
  } catch {
    // An invalid timezone must not silently disable quiet hours in the wrong
    // direction; fall back to UTC.
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}
