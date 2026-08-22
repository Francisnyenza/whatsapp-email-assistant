import { describe, it, expect, vi } from 'vitest';
import { AuditService } from '../src/common/audit.service.js';

/**
 * The audit trail, which until now was a table nothing wrote to.
 *
 * `audit_logs` has existed since the first migration — with indexes, a comment
 * describing what belongs in it, and grants rejecting UPDATE and DELETE at both
 * the role and the trigger level. No code ever inserted a row. A control that
 * is documented and absent is worse than one that is absent, because nobody
 * goes looking for it; this is the third instance of that shape found in this
 * codebase, after `KMS_PROVIDER` and the three `RATE_LIMIT_*` settings.
 *
 * The property that matters most here is the one about failure. An audit write
 * that can fail its own request means a full disk takes down the thing being
 * audited, which is a worse security outcome than a missing row.
 */

function service(create = vi.fn(async () => ({}))) {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const prisma = { auditLog: { create } };

  return { audit: new AuditService(prisma as never, logger as never), create, logger };
}

describe('writing an entry', () => {
  it('records the action, who, and the outcome', async () => {
    const { audit, create } = service();

    await audit.record({
      action: 'auth.signin',
      userId: 'user-1',
      ipAddress: '203.0.113.7',
      userAgent: 'curl/8',
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'auth.signin',
        userId: 'user-1',
        success: true,
        ipAddress: '203.0.113.7',
        userAgent: 'curl/8',
      }) as never,
    });
  });

  it('accepts an entry with no user, which is the one most worth having', async () => {
    // A sign-in attempt against an address that does not exist. `audit_logs`
    // carries no tenant policy precisely so this row can be written — a policy
    // would refuse exactly the entries an investigation wants.
    const { audit, create } = service();

    await audit.record({ action: 'auth.signin', success: false, failureReason: 'no such account' });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: null, success: false }) as never,
    });
  });

  it('defaults metadata to an object rather than null', async () => {
    // The column is `Json @default("{}")` and NOT NULL. Passing null would be
    // a constraint violation on a write that must never fail loudly.
    const { audit, create } = service();

    await audit.record({ action: 'auth.signout', userId: 'user-1' });

    expect(create.mock.calls[0]![0].data.metadata).toEqual({});
  });
});

describe('when the write fails', () => {
  it('does not fail the request it was describing', async () => {
    // The whole point. A full disk must not turn into an outage of the thing
    // being audited.
    const { audit } = service(
      vi.fn(async () => {
        throw new Error('disk full');
      }),
    );

    await expect(audit.record({ action: 'auth.signin', userId: 'u' })).resolves.toBeUndefined();
  });

  it('says so at error, so a gap in the trail is not silent', async () => {
    const { audit, logger } = service(
      vi.fn(async () => {
        throw new Error('disk full');
      }),
    );

    await audit.record({ action: 'auth.signin', userId: 'u' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.write_failed', action: 'auth.signin' }),
      expect.any(String),
    );
  });
});
