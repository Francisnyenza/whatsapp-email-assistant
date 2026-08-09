import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PreferencesService } from '../src/accounts/preferences.service.js';

/**
 * The settings that decide when someone hears from us.
 *
 * Small surface, and every field on it can silence notifications — a settings
 * screen that lets someone turn themselves off by accident is indistinguishable
 * from a broken product. So most of this file is about rejecting rather than
 * coercing: a malformed `08:0` has to become an error the UI can show, never a
 * digest time that silently never fires.
 *
 * The allowlist is the other half. This writes to a row that also holds
 * `retentionBodyDays`, which is a data-retention promise rather than a
 * preference — a mass-assignment bug here would let a PATCH extend how long we
 * keep someone's mail, and would be invisible until somebody went looking.
 */

describe('reading preferences', () => {
  it('returns what is stored', async () => {
    const service = build({
      notificationMode: 'digest',
      minimumPriority: 'high',
      digestTimes: ['08:00'],
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      mutedCategories: ['promotion'],
      mutedSenders: ['noreply@x.com'],
      includeSummary: true,
      signature: null,
    });

    expect(await service.get('user-1')).toMatchObject({
      notificationMode: 'digest',
      digestTimes: ['08:00'],
    });
  });

  it('says so when the row is missing rather than inventing defaults', async () => {
    // Created eagerly at signup, so absence means it went missing — and invented
    // defaults would then be written back over whatever the user actually chose.
    const service = build(null);

    await expect(service.get('user-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('what a patch may change', () => {
  it('applies only the fields it names', async () => {
    // Partial on purpose: a settings screen that PUTs the whole object races
    // with its own tabs, and the loser silently reverts the other's change.
    const { service, update } = buildWithSpy();

    await service.update('user-1', { notificationMode: 'digest' });

    expect(update.mock.calls[0]![0].data).toEqual({ notificationMode: 'digest' });
  });

  it('refuses a field that is not a preference', async () => {
    // `retentionBodyDays` lives on this row and is a retention promise, not a
    // setting. It is not in the allowlist, so it cannot be reached.
    const { service } = buildWithSpy();

    await expect(service.update('user-1', { retentionBodyDays: 3650 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('ignores unknown fields alongside known ones', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { includeSummary: false, isPlatformAdmin: true });

    expect(update.mock.calls[0]![0].data).toEqual({ includeSummary: false });
  });

  it('refuses a body that is not an object', async () => {
    const { service } = buildWithSpy();

    for (const body of [null, 'nope', 42, undefined]) {
      await expect(service.update('user-1', body)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });
});

describe('digest times', () => {
  it('accepts 24-hour times', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { digestTimes: ['08:00', '18:30', '23:59'] });

    expect(update.mock.calls[0]![0].data.digestTimes).toEqual(['08:00', '18:30', '23:59']);
  });

  it('rejects a malformed time rather than dropping it', async () => {
    // A dropped time is a digest that silently never arrives, and the user has
    // no way to tell that apart from us being broken.
    const { service } = buildWithSpy();

    for (const bad of ['08:0', '8:00', '24:00', '08:60', 'morning', '']) {
      await expect(service.update('user-1', { digestTimes: [bad] })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('de-duplicates and sorts, so one morning cannot produce two digests', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { digestTimes: ['18:00', '08:00', '08:00'] });

    expect(update.mock.calls[0]![0].data.digestTimes).toEqual(['08:00', '18:00']);
  });

  it('accepts an empty list, which is how someone turns digests off', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { digestTimes: [] });

    expect(update.mock.calls[0]![0].data.digestTimes).toEqual([]);
  });

  it('bounds how many there can be', async () => {
    const { service } = buildWithSpy();

    await expect(
      service.update('user-1', { digestTimes: Array(20).fill('08:00') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the enumerated fields', () => {
  it('accepts every real notification mode', async () => {
    for (const mode of ['instant', 'digest', 'priority_only', 'off']) {
      const { service, update } = buildWithSpy();
      await service.update('user-1', { notificationMode: mode });
      expect(update.mock.calls[0]![0].data.notificationMode).toBe(mode);
    }
  });

  it('refuses one the database would reject', async () => {
    // Postgres would refuse this too, but with a 500 and an enum name in it.
    const { service } = buildWithSpy();

    await expect(service.update('user-1', { notificationMode: 'sometimes' })).rejects.toMatchObject(
      { code: 'VALIDATION_FAILED' },
    );
  });

  it('refuses an unknown muted category', async () => {
    const { service } = buildWithSpy();

    await expect(
      service.update('user-1', { mutedCategories: ['work', 'nonsense'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('quiet hours', () => {
  it('takes a start and an end', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', {
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });

    expect(update.mock.calls[0]![0].data).toMatchObject({
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
    });
  });

  it('refuses a malformed one', async () => {
    const { service } = buildWithSpy();

    await expect(service.update('user-1', { quietHoursStart: '10pm' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('requires a boolean for the toggle, not a truthy string', async () => {
    const { service } = buildWithSpy();

    await expect(service.update('user-1', { quietHoursEnabled: 'yes' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('muted senders and the signature', () => {
  it('normalizes senders, because a mute that is case-sensitive is not a mute', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', {
      mutedSenders: [' NoReply@Acme.com ', 'noreply@acme.com', ''],
    });

    expect(update.mock.calls[0]![0].data.mutedSenders).toEqual(['noreply@acme.com']);
  });

  it('bounds the signature, which goes out on every reply under the user’s name', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { signature: 'x'.repeat(2_000) });

    expect(update.mock.calls[0]![0].data.signature).toHaveLength(500);
  });

  it('treats an empty signature as none', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { signature: '   ' });

    expect(update.mock.calls[0]![0].data.signature).toBeNull();
  });

  it('accepts null to clear it', async () => {
    const { service, update } = buildWithSpy();

    await service.update('user-1', { signature: null });

    expect(update.mock.calls[0]![0].data.signature).toBeNull();
  });
});

describe('an empty patch', () => {
  it('is refused rather than silently doing nothing', async () => {
    // A UI that sent one has a bug, and a 204 would hide it.
    const { service } = buildWithSpy();

    await expect(service.update('user-1', {})).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

/* --------------------------------- helpers -------------------------------- */

const STORED = {
  notificationMode: 'instant',
  minimumPriority: 'normal',
  digestTimes: ['08:00', '18:00'],
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  mutedCategories: [],
  mutedSenders: [],
  includeSummary: true,
  signature: null,
};

function build(row: Record<string, unknown> | null) {
  const prisma = {
    forUser: <T>(_id: string, fn: (tx: unknown) => Promise<T>) =>
      fn({ userPreference: { findUnique: async () => row, update: async () => row } }),
  };
  return new PreferencesService(prisma as never);
}

function buildWithSpy() {
  const update = vi.fn().mockResolvedValue(STORED);
  const prisma = {
    forUser: <T>(_id: string, fn: (tx: unknown) => Promise<T>) =>
      fn({ userPreference: { findUnique: async () => STORED, update } }),
  };
  return { service: new PreferencesService(prisma as never), update };
}

beforeEach(() => {
  vi.clearAllMocks();
});
