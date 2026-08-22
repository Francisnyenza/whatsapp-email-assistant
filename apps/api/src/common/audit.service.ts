import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { PrismaService } from './prisma.service.js';

/**
 * The security-relevant record of who did what.
 *
 * `audit_logs` has been in the schema since the first migration, with indexes,
 * a comment describing what belongs in it, and grants that reject UPDATE and
 * DELETE at both the role and the trigger level. Nothing ever wrote a row. The
 * table was a claim rather than a control — the same shape as `KMS_PROVIDER`,
 * which four call sites ignored, and the three `RATE_LIMIT_*` settings nothing
 * read.
 *
 * What goes in it is the set of events someone would need to answer "was this
 * account taken over, and what did they reach": authentication outcomes,
 * session revocations, second-factor changes, and mailbox connections. Not
 * ordinary product activity — reading mail is what the product *is*, and an
 * audit log that records every message read is a second copy of the mailbox
 * with worse access control.
 *
 * **A failed audit write never fails the request.** The alternative is that a
 * full disk or a slow database turns into an outage of the thing being audited,
 * which is a worse security outcome than a missing row. The failure is logged
 * at `error`, so a silent gap in the trail is not silent.
 */

/**
 * The events written here, as a closed set.
 *
 * A string would let call sites invent names, and an audit trail whose
 * vocabulary drifts cannot be queried — "show me every failed sign-in" stops
 * working the moment someone writes `auth.signin_failed` next to
 * `auth.login_failed`.
 */
export type AuditAction =
  | 'auth.signup'
  | 'auth.signin'
  | 'auth.signout'
  | 'auth.signout_all'
  | 'auth.refresh_reuse_detected'
  | 'auth.2fa_enabled'
  | 'auth.2fa_disabled'
  | 'auth.phone_verified'
  | 'account.connected'
  | 'account.disconnected';

export interface AuditEntry {
  action: AuditAction;
  /** Null for a sign-in attempt against an address that does not exist. */
  userId?: string | null;
  resource?: string;
  resourceId?: string;
  success?: boolean;
  /** Why it failed, in words safe to store — never the credential that failed. */
  failureReason?: string;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  /**
   * Anything else worth keeping. Redacted by the caller: this column must never
   * hold a token, a password, a message body or a full email address — the
   * table is read by people investigating an incident, and a trail that leaks
   * what it was protecting is worse than none.
   */
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Writes one entry.
   *
   * Unscoped by necessity, and safe: a failed sign-in has no user to scope to,
   * which is exactly the entry an investigation most wants. `audit_logs`
   * carries no tenant policy for that reason — the alternative is a policy that
   * refuses precisely the rows worth writing. It is protected instead by being
   * append-only: the application's role may INSERT and SELECT and nothing else,
   * enforced by grant and by trigger, so a compromised API can add noise to the
   * trail but cannot remove what is already there.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          userId: entry.userId ?? null,
          resource: entry.resource ?? null,
          resourceId: entry.resourceId ?? null,
          success: entry.success ?? true,
          failureReason: entry.failureReason ?? null,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          requestId: entry.requestId ?? null,
          metadata: (entry.metadata ?? {}) as never,
        },
      });
    } catch (err) {
      // Never rethrow. See the class comment: losing the request to record it
      // is the wrong trade in both directions.
      this.logger.error(
        { event: 'audit.write_failed', action: entry.action, err },
        'Could not write an audit entry',
      );
    }
  }
}
