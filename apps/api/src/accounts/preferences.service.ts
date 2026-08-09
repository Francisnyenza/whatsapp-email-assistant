import { Injectable } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';

/**
 * The settings that decide when and how someone hears from us.
 *
 * Small, and worth being careful with anyway: every field here can silence
 * notifications, and a settings screen that lets someone turn themselves off by
 * accident is indistinguishable from a broken product. So the validation below
 * rejects rather than coerces — a malformed `08:0` becomes an error the UI can
 * show, never a time that silently never fires.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<Preferences> {
    const row = await this.prisma.forUser(userId, async (tx) =>
      tx.userPreference.findUnique({ where: { userId } }),
    );

    if (!row) {
      // Created eagerly at signup, so this means a row went missing rather than
      // a user who never had one. Saying so beats inventing defaults that would
      // then be silently written back over whatever they actually chose.
      throw new AppError('NOT_FOUND', 'Preferences not found');
    }

    return {
      notificationMode: row.notificationMode,
      minimumPriority: row.minimumPriority,
      digestTimes: row.digestTimes,
      quietHoursEnabled: row.quietHoursEnabled,
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      mutedCategories: row.mutedCategories,
      mutedSenders: row.mutedSenders,
      includeSummary: row.includeSummary,
      signature: row.signature,
    };
  }

  /**
   * Applies a partial update.
   *
   * Partial on purpose: a settings screen that PUTs the whole object races with
   * itself across two open tabs, and the loser silently reverts a change the
   * user made in the other one.
   */
  async update(userId: string, patch: unknown): Promise<Preferences> {
    const data = validate(patch);

    if (Object.keys(data).length === 0) {
      throw new AppError('VALIDATION_FAILED', 'No recognised settings in the request', {
        publicMessage: 'Nothing to change.',
      });
    }

    await this.prisma.forUser(userId, async (tx) => {
      await tx.userPreference.update({ where: { userId }, data });
    });

    return this.get(userId);
  }
}

export interface Preferences {
  notificationMode: string;
  minimumPriority: string;
  digestTimes: string[];
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  mutedCategories: string[];
  mutedSenders: string[];
  includeSummary: boolean;
  signature: string | null;
}

const MODES = new Set(['instant', 'digest', 'priority_only', 'off']);
const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const CATEGORIES = new Set([
  'primary',
  'work',
  'personal',
  'finance',
  'invoice',
  'travel',
  'shopping',
  'social',
  'newsletter',
  'promotion',
  'notification',
  'support',
  'recruitment',
  'legal',
  'spam',
  'other',
]);

/** `HH:MM`, 24-hour. The digest sweep parses exactly this and skips anything else. */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * What the request is allowed to change.
 *
 * An allowlist rather than a spread, because the row this writes to also holds
 * `retentionBodyDays` — which is a data-retention promise, not a preference a
 * PATCH should be able to extend — and because a mass-assignment bug here would
 * be invisible until someone found it.
 */
function validate(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object') {
    throw new AppError('VALIDATION_FAILED', 'Body must be an object');
  }

  const input = patch as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  if ('notificationMode' in input) {
    data['notificationMode'] = requireOneOf(input['notificationMode'], MODES, 'notificationMode');
  }

  if ('minimumPriority' in input) {
    data['minimumPriority'] = requireOneOf(input['minimumPriority'], PRIORITIES, 'minimumPriority');
  }

  if ('digestTimes' in input) {
    const times = requireStringArray(input['digestTimes'], 'digestTimes', 6);
    for (const time of times) {
      if (!TIME.test(time)) {
        // Rejected rather than dropped. A time the sweep cannot parse is a
        // digest that silently never arrives, and the user would have no way to
        // tell that from us being broken.
        throw new AppError('VALIDATION_FAILED', `digestTimes contains an invalid time: ${time}`, {
          publicMessage: 'Digest times must look like 08:00.',
        });
      }
    }
    // Sorted and de-duplicated so "08:00, 08:00, 07:00" cannot produce two
    // digests in one morning and a confusing settings screen afterwards.
    data['digestTimes'] = [...new Set(times)].sort();
  }

  if ('quietHoursEnabled' in input) {
    data['quietHoursEnabled'] = requireBoolean(input['quietHoursEnabled'], 'quietHoursEnabled');
  }

  for (const field of ['quietHoursStart', 'quietHoursEnd'] as const) {
    if (field in input) {
      const value = input[field];
      if (typeof value !== 'string' || !TIME.test(value)) {
        throw new AppError('VALIDATION_FAILED', `${field} must look like 22:00`, {
          publicMessage: 'Quiet hours must look like 22:00.',
        });
      }
      data[field] = value;
    }
  }

  if ('mutedCategories' in input) {
    const categories = requireStringArray(input['mutedCategories'], 'mutedCategories', 20);
    for (const category of categories) {
      if (!CATEGORIES.has(category)) {
        throw new AppError('VALIDATION_FAILED', `Unknown category: ${category}`);
      }
    }
    data['mutedCategories'] = [...new Set(categories)];
  }

  if ('mutedSenders' in input) {
    const senders = requireStringArray(input['mutedSenders'], 'mutedSenders', 200);
    data['mutedSenders'] = [...new Set(senders.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  if ('includeSummary' in input) {
    data['includeSummary'] = requireBoolean(input['includeSummary'], 'includeSummary');
  }

  if ('signature' in input) {
    const signature = input['signature'];
    if (signature === null) {
      data['signature'] = null;
    } else if (typeof signature === 'string') {
      // Bounded because it is appended to every outbound reply, which goes to a
      // real correspondent under the user's own name.
      const trimmed = signature.trim().slice(0, 500);
      data['signature'] = trimmed || null;
    } else {
      throw new AppError('VALIDATION_FAILED', 'signature must be a string or null');
    }
  }

  return data;
}

function requireOneOf(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new AppError('VALIDATION_FAILED', `${field} must be one of: ${[...allowed].join(', ')}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AppError('VALIDATION_FAILED', `${field} must be true or false`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new AppError('VALIDATION_FAILED', `${field} must be an array of strings`);
  }
  if (value.length > max) {
    throw new AppError('VALIDATION_FAILED', `${field} accepts at most ${max} entries`);
  }
  return value as string[];
}
