import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PhoneVerificationService } from '../src/auth/phone-verification.service.js';

/**
 * Proving a phone number belongs to whoever claimed it.
 *
 * `phone_verified` existed from the first migration and was read by nothing,
 * which made three things true at once. A typo at signup sent someone's inbox
 * summaries to a stranger's phone. The `UNIQUE` constraint meant claiming a
 * number you did not own squatted it, so its real owner could never register.
 * And an inbound message resolved to whoever claimed it, so the squatter's
 * mailbox was the one a victim's commands acted on.
 *
 * The code is a bearer credential that binds a number to an account, so most of
 * what is checked here is that it behaves like one: hashed at rest, single use,
 * short-lived, and never able to move a number away from its current owner.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('issuing a code', () => {
  let service: PhoneVerificationService;
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    update = vi.fn().mockResolvedValue({});
    service = new PhoneVerificationService(
      { user: { update } } as never,
      { info: vi.fn(), warn: vi.fn() } as never,
    );
  });

  it('returns the code once and stores only its hash', async () => {
    const { code } = await service.start('user-1');

    expect(update.mock.calls[0]![0].data.phoneVerificationCodeHash).toBe(sha256(code));
    // The plaintext is never written.
    expect(JSON.stringify(update.mock.calls[0]![0].data)).not.toContain(code);
  });

  it('uses an alphabet with nothing ambiguous on a phone screen', async () => {
    // No O/0, no I/1/L, no U. A substitution the user makes reading it back
    // would otherwise be accepted as a different code — or, worse, silently
    // rejected with no way to tell why.
    for (let i = 0; i < 50; i++) {
      const { code } = await service.start('user-1');
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    }
  });

  it('is unpredictable between calls', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add((await service.start('user-1')).code);
    expect(codes.size).toBe(50);
  });

  it('expires it, so one read over a shoulder is not useful later', async () => {
    const { expiresAt } = await service.start('user-1');
    const minutes = (expiresAt.getTime() - Date.now()) / 60_000;

    expect(minutes).toBeGreaterThan(8);
    expect(minutes).toBeLessThanOrEqual(10);
  });
});

describe('redeeming a code', () => {
  let service: PhoneVerificationService;
  let findFirst: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findFirst = vi.fn().mockResolvedValue({ id: 'user-1' });
    update = vi.fn().mockResolvedValue({});
    service = new PhoneVerificationService(
      { user: { findFirst, update } } as never,
      { info: vi.fn(), warn: vi.fn() } as never,
    );
  });

  it('links the number it arrived from and marks it verified', async () => {
    const result = await service.redeem('ABCD2345', '+254712345678');

    expect(result).toEqual({ userId: 'user-1', phoneNumber: '+254712345678' });
    expect(update.mock.calls[0]![0].data).toMatchObject({
      phoneNumber: '+254712345678',
      phoneVerified: true,
    });
  });

  it('looks the code up by hash, never by value', async () => {
    await service.redeem('ABCD2345', '+254712345678');

    expect(findFirst.mock.calls[0]![0].where.phoneVerificationCodeHash).toBe(sha256('ABCD2345'));
  });

  it('only considers a code that has not expired', async () => {
    await service.redeem('ABCD2345', '+254712345678');

    const where = findFirst.mock.calls[0]![0].where;
    expect(where.phoneVerificationExpiresAt.gt).toBeInstanceOf(Date);
  });

  it('spends it, so it cannot link a second account later', async () => {
    await service.redeem('ABCD2345', '+254712345678');

    expect(update.mock.calls[0]![0].data).toMatchObject({
      phoneVerificationCodeHash: null,
      phoneVerificationExpiresAt: null,
    });
  });

  it('accepts the sloppiness people actually type', async () => {
    for (const typed of ['abcd2345', ' ABCD2345 ', 'ABCD-2345', 'abcd 2345']) {
      findFirst.mockClear();
      await service.redeem(typed, '+254712345678');
      expect(findFirst.mock.calls[0]![0].where.phoneVerificationCodeHash).toBe(sha256('ABCD2345'));
    }
  });

  it('ignores anything that is not a code, without a database round trip', async () => {
    // Most messages from an unknown number are not codes. Hitting the database
    // for every one of them would make the endpoint a free lookup oracle.
    for (const text of ['hello', '', 'ABCD234', 'ABCD23456', 'ABCD01IL', 'archive this']) {
      expect(await service.redeem(text, '+254712345678')).toBeNull();
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('refuses a phone number that will not normalize', async () => {
    expect(await service.redeem('ABCD2345', 'not-a-number')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns null for a code nobody holds', async () => {
    findFirst.mockResolvedValue(null);

    expect(await service.redeem('ABCD2345', '+254712345678')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to move a number away from the account that holds it', async () => {
    // Silently reassigning would let anyone who can send one message take a
    // number from its current owner — and take their notifications with it.
    update.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(service.redeem('ABCD2345', '+254712345678')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('status and unlinking', () => {
  let service: PhoneVerificationService;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findUnique = vi.fn();
    update = vi.fn().mockResolvedValue({});
    service = new PhoneVerificationService(
      { user: { findUnique, update } } as never,
      { info: vi.fn(), warn: vi.fn() } as never,
    );
  });

  it('reports a linked number', async () => {
    findUnique.mockResolvedValue({
      phoneNumber: '+254712345678',
      phoneVerified: true,
      phoneVerificationExpiresAt: null,
    });

    expect(await service.status('user-1')).toEqual({
      phoneNumber: '+254712345678',
      verified: true,
      codePending: false,
    });
  });

  it('reports a live code as pending and an expired one as not', async () => {
    findUnique.mockResolvedValue({
      phoneNumber: null,
      phoneVerified: false,
      phoneVerificationExpiresAt: new Date(Date.now() + 60_000),
    });
    expect((await service.status('user-1')).codePending).toBe(true);

    findUnique.mockResolvedValue({
      phoneNumber: null,
      phoneVerified: false,
      phoneVerificationExpiresAt: new Date(Date.now() - 60_000),
    });
    expect((await service.status('user-1')).codePending).toBe(false);
  });

  it('clears the verified flag when unlinking, not just the number', async () => {
    // A number that is no longer ours to send to must not read as proved if it
    // is ever re-attached by a migration or a restore.
    await service.unlink('user-1');

    expect(update.mock.calls[0]![0].data).toEqual({
      phoneNumber: null,
      phoneVerified: false,
      phoneVerificationCodeHash: null,
      phoneVerificationExpiresAt: null,
    });
  });
});
