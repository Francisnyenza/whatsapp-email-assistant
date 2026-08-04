import { describe, it, expect } from 'vitest';
import {
  evaluateWindow,
  isWindowOpen,
  decideDelivery,
  inQuietHours,
  type DeliveryPreferences,
} from '../src/index.js';

const HOUR = 3_600_000;
const now = new Date('2026-08-04T12:00:00Z');

const prefs = (overrides: Partial<DeliveryPreferences> = {}): DeliveryPreferences => ({
  mode: 'instant',
  minimumPriority: 'normal',
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  timezone: 'UTC',
  mutedCategories: [],
  mutedSenders: [],
  ...overrides,
});

const candidate = (overrides = {}) => ({
  priority: 'normal' as const,
  category: 'work',
  fromAddress: 'sarah@acme.com',
  ...overrides,
});

describe('24-hour customer service window', () => {
  it('is open just inside 24 hours', () => {
    const state = { lastInboundAt: new Date(now.getTime() - 23.9 * HOUR) };
    expect(evaluateWindow(state, now).mode).toBe('free_form');
    expect(isWindowOpen(state, now)).toBe(true);
  });

  it('is closed just outside 24 hours', () => {
    const state = { lastInboundAt: new Date(now.getTime() - 24.1 * HOUR) };
    expect(evaluateWindow(state, now).mode).toBe('template_only');
    expect(evaluateWindow(state, now).remainingMs).toBe(0);
  });

  it('is closed for a user who has never messaged us', () => {
    expect(evaluateWindow({ lastInboundAt: null }, now).mode).toBe('template_only');
  });

  it('reports the time remaining', () => {
    const state = { lastInboundAt: new Date(now.getTime() - 20 * HOUR) };
    expect(evaluateWindow(state, now).remainingMs).toBe(4 * HOUR);
  });

  it('flags a window about to close', () => {
    const closing = { lastInboundAt: new Date(now.getTime() - 23.75 * HOUR) };
    expect(evaluateWindow(closing, now).closingSoon).toBe(true);

    const fresh = { lastInboundAt: new Date(now.getTime() - 1 * HOUR) };
    expect(evaluateWindow(fresh, now).closingSoon).toBe(false);
  });

  it('clamps a future timestamp rather than extending the window', () => {
    // Clock skew between our servers and Meta's must not buy us a window Meta
    // will not honour.
    const skewed = { lastInboundAt: new Date(now.getTime() + 5 * HOUR) };
    const decision = evaluateWindow(skewed, now);
    expect(decision.mode).toBe('free_form');
    expect(decision.remainingMs).toBeLessThanOrEqual(24 * HOUR);
  });
});

describe('delivery decisions', () => {
  const open = evaluateWindow({ lastInboundAt: new Date(now.getTime() - HOUR) }, now);
  const closed = evaluateWindow({ lastInboundAt: null }, now);

  it('sends immediately when the window is open', () => {
    expect(decideDelivery(candidate(), prefs(), open, now)).toEqual({ action: 'send_now' });
  });

  it('suppresses everything when notifications are off', () => {
    expect(decideDelivery(candidate(), prefs({ mode: 'off' }), open, now)).toEqual({
      action: 'suppress',
      reason: 'off',
    });
  });

  describe('muting outranks everything', () => {
    it('suppresses a muted sender even when urgent', () => {
      const action = decideDelivery(
        candidate({ priority: 'urgent' }),
        prefs({ mutedSenders: ['sarah@acme.com'] }),
        open,
        now,
      );
      expect(action).toEqual({ action: 'suppress', reason: 'muted_sender' });
    });

    it('supports muting a whole domain', () => {
      const action = decideDelivery(
        candidate({ fromAddress: 'noreply@spammy.io' }),
        prefs({ mutedSenders: ['@spammy.io'] }),
        open,
        now,
      );
      expect(action).toEqual({ action: 'suppress', reason: 'muted_sender' });
    });

    it('matches muted senders case-insensitively', () => {
      const action = decideDelivery(
        candidate({ fromAddress: 'Sarah@ACME.com' }),
        prefs({ mutedSenders: ['sarah@acme.com'] }),
        open,
        now,
      );
      expect(action).toEqual({ action: 'suppress', reason: 'muted_sender' });
    });

    it('suppresses a muted category', () => {
      const action = decideDelivery(
        candidate({ category: 'newsletter' }),
        prefs({ mutedCategories: ['newsletter'] }),
        open,
        now,
      );
      expect(action).toEqual({ action: 'suppress', reason: 'muted_category' });
    });

    it('never costs a template send for muted mail', () => {
      // Suppression is evaluated before the window, so a muted newsletter
      // arriving at 3am is free, not billable.
      const action = decideDelivery(
        candidate({ category: 'newsletter', priority: 'high' }),
        prefs({ mutedCategories: ['newsletter'] }),
        closed,
        now,
      );
      expect(action.action).toBe('suppress');
    });
  });

  describe('priority filtering', () => {
    it('suppresses below the floor in priority_only mode', () => {
      const action = decideDelivery(
        candidate({ priority: 'low' }),
        prefs({ mode: 'priority_only', minimumPriority: 'high' }),
        open,
        now,
      );
      expect(action).toEqual({ action: 'suppress', reason: 'below_priority' });
    });

    it('passes at or above the floor', () => {
      for (const priority of ['high', 'urgent'] as const) {
        const action = decideDelivery(
          candidate({ priority }),
          prefs({ mode: 'priority_only', minimumPriority: 'high' }),
          open,
          now,
        );
        expect(action, priority).toEqual({ action: 'send_now' });
      }
    });
  });

  it('defers everything in digest mode', () => {
    expect(decideDelivery(candidate(), prefs({ mode: 'digest' }), open, now)).toEqual({
      action: 'defer',
      reason: 'digest_mode',
    });
  });

  describe('quiet hours', () => {
    const night = new Date('2026-08-04T23:30:00Z');

    it('defers during quiet hours', () => {
      const action = decideDelivery(candidate(), prefs({ quietHoursEnabled: true }), open, night);
      expect(action).toEqual({ action: 'defer', reason: 'quiet_hours' });
    });

    it('lets urgent mail through', () => {
      const action = decideDelivery(
        candidate({ priority: 'urgent' }),
        prefs({ quietHoursEnabled: true }),
        open,
        night,
      );
      expect(action).toEqual({ action: 'send_now' });
    });

    it('handles a range crossing midnight', () => {
      const p = prefs({
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
      });
      expect(inQuietHours(new Date('2026-08-04T23:00:00Z'), p)).toBe(true);
      expect(inQuietHours(new Date('2026-08-05T03:00:00Z'), p)).toBe(true);
      expect(inQuietHours(new Date('2026-08-05T06:59:00Z'), p)).toBe(true);
      expect(inQuietHours(new Date('2026-08-05T07:00:00Z'), p)).toBe(false);
      expect(inQuietHours(new Date('2026-08-04T12:00:00Z'), p)).toBe(false);
    });

    it('handles a range within one day', () => {
      const p = prefs({
        quietHoursEnabled: true,
        quietHoursStart: '09:00',
        quietHoursEnd: '17:00',
      });
      expect(inQuietHours(new Date('2026-08-04T12:00:00Z'), p)).toBe(true);
      expect(inQuietHours(new Date('2026-08-04T20:00:00Z'), p)).toBe(false);
    });

    it('respects the user’s own timezone, not the server’s', () => {
      // 23:30 UTC is 02:30 in Nairobi — quiet — and 19:30 in New York — not.
      const p = (timezone: string) => prefs({ quietHoursEnabled: true, timezone });
      expect(inQuietHours(night, p('Africa/Nairobi'))).toBe(true);
      expect(inQuietHours(night, p('America/New_York'))).toBe(false);
    });

    it('falls back to UTC for an invalid timezone rather than throwing', () => {
      expect(() =>
        inQuietHours(night, prefs({ quietHoursEnabled: true, timezone: 'Mars/Olympus' })),
      ).not.toThrow();
    });

    it('treats a malformed range as no quiet hours', () => {
      const p = prefs({ quietHoursEnabled: true, quietHoursStart: '25:00', quietHoursEnd: 'oops' });
      expect(inQuietHours(night, p)).toBe(false);
    });
  });

  describe('when the window is closed', () => {
    it('spends a template only on mail the user wants immediately', () => {
      expect(decideDelivery(candidate({ priority: 'urgent' }), prefs(), closed, now)).toEqual({
        action: 'send_template',
        reason: 'window_closed',
      });
      expect(decideDelivery(candidate({ priority: 'high' }), prefs(), closed, now)).toEqual({
        action: 'send_template',
        reason: 'window_closed',
      });
    });

    it('defers everything else to the digest', () => {
      // Template sends are billable; normal mail waits until the user next
      // messages us and the window reopens for free.
      for (const priority of ['normal', 'low'] as const) {
        expect(decideDelivery(candidate({ priority }), prefs(), closed, now), priority).toEqual({
          action: 'defer',
          reason: 'window_closed',
        });
      }
    });
  });
});
