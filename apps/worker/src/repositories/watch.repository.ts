import { Injectable } from '@nestjs/common';
import { withoutTenantScope } from '@wea/db';
import { PrismaService } from '../common/prisma.service.js';

export interface DueWatch {
  userId: string;
  accountId: string;
  /** Null when the account has no watch at all — the polling fallback. */
  expiresAt: Date | null;
}

/**
 * Finding and recording Gmail watch subscriptions.
 *
 * Reads come from `provider_account_routes`, which is outside tenant isolation
 * by design; writes go through the tenant-scoped path, because they touch
 * `email_accounts`. That split is the whole point: the sweep learns *which*
 * accounts to renew without ever being able to read one, and the renewal itself
 * runs as the user who owns the mailbox.
 *
 * The two expiry columns are written together in one transaction. They are a
 * source of truth and an index into it, and an index that drifts newer than its
 * source is a mailbox that silently stops receiving mail.
 */
@Injectable()
export class WatchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Accounts whose watch has lapsed or will lapse within the horizon.
   *
   * Ordered by expiry with NULLs first, so accounts with no watch at all — the
   * ones receiving nothing right now — are renewed before ones that still have
   * days left.
   */
  async findDue(horizonHours: number, limit: number): Promise<DueWatch[]> {
    const horizon = new Date(Date.now() + horizonHours * 3_600_000);

    return withoutTenantScope(this.prisma, 'watch-renewal', async (db) => {
      const routes = await db.providerAccountRoute.findMany({
        where: {
          provider: 'gmail',
          OR: [{ watchExpiresAt: null }, { watchExpiresAt: { lt: horizon } }],
        },
        select: { userId: true, accountId: true, watchExpiresAt: true },
        orderBy: { watchExpiresAt: { sort: 'asc', nulls: 'first' } },
        take: limit,
      });

      return routes.map((route) => ({
        userId: route.userId,
        accountId: route.accountId,
        expiresAt: route.watchExpiresAt,
      }));
    });
  }

  /**
   * Accounts with no push subscription at all.
   *
   * A null expiry on the route is exactly the condition: it is written when a
   * watch could not be established and cleared when one is. So the table that
   * exists to route pushes also, usefully, knows which mailboxes are not
   * receiving any — and it can be read without a tenant, which is what a
   * scheduled sweep needs.
   *
   * Self-limiting: the moment a watch succeeds the expiry is set and the account
   * stops appearing here.
   */
  async findWithoutWatch(limit: number): Promise<DueWatch[]> {
    return withoutTenantScope(this.prisma, 'watch-renewal', async (db) => {
      const routes = await db.providerAccountRoute.findMany({
        where: { provider: 'gmail', watchExpiresAt: null },
        select: { userId: true, accountId: true, watchExpiresAt: true },
        // Oldest route first, so a mailbox that has been unwatched longest is
        // polled before one that was linked a moment ago and is probably about
        // to get a watch anyway.
        orderBy: { createdAt: 'asc' },
        take: limit,
      });

      return routes.map((route) => ({
        userId: route.userId,
        accountId: route.accountId,
        expiresAt: route.watchExpiresAt,
      }));
    });
  }

  /**
   * Records a renewed watch.
   *
   * `cursor` is Gmail's current historyId, and it is written **only when the
   * account has none**. Overwriting an existing cursor with "now" would skip
   * every message that arrived between the stored position and the renewal —
   * mail the user would never hear about, which is the failure this whole sweep
   * exists to prevent.
   */
  async recordRenewed(
    userId: string,
    accountId: string,
    expiresAt: Date,
    cursor: string,
    /**
     * Graph's subscription id, which can change: a renewal that found the old
     * subscription gone creates a new one, and the id has to move with it or
     * the next renewal PATCHes something that no longer exists. Gmail sends
     * none, so it is simply absent rather than a second concept.
     */
    subscriptionId?: string,
  ): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      const account = await tx.emailAccount.findUnique({
        where: { id: accountId },
        select: { syncCursor: true },
      });

      await tx.emailAccount.update({
        where: { id: accountId },
        data: {
          status: 'active',
          watchExpiresAt: expiresAt,
          // Back on push; the polling fallback no longer applies.
          pollingSince: null,
          consecutiveFailures: 0,
          ...(account?.syncCursor ? {} : { syncCursor: cursor }),
          ...(subscriptionId ? { watchSubscriptionId: subscriptionId } : {}),
        },
      });

      // Same transaction as the line above, deliberately. See the class comment.
      await tx.providerAccountRoute.updateMany({
        where: { accountId },
        data: { watchExpiresAt: expiresAt },
      });
    });
  }

  /**
   * Records that a watch could not be established.
   *
   * The account keeps working — `pollingSince` marks it for the polling
   * fallback — but its route expiry is cleared so the next sweep finds it
   * first rather than treating it as healthy.
   */
  async recordUnavailable(userId: string, accountId: string, code: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: {
          watchExpiresAt: null,
          pollingSince: new Date(),
          lastErrorCode: code,
          lastErrorAt: new Date(),
        },
      });

      await tx.providerAccountRoute.updateMany({
        where: { accountId },
        data: { watchExpiresAt: null },
      });
    });
  }

  /**
   * Records a renewal attempt that failed for a reason worth retrying.
   *
   * Deliberately leaves both expiry columns alone. A timeout says nothing about
   * when the subscription lapses — the existing watch is still valid until it
   * isn't — and rewriting the expiry on every transient failure would replace a
   * true record with a guess.
   */
  async recordRenewalFailure(userId: string, accountId: string, code: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: {
          consecutiveFailures: { increment: 1 },
          lastErrorCode: code,
          lastErrorAt: new Date(),
        },
      });
    });
  }

  /**
   * Removes the route for a mailbox we can no longer reach.
   *
   * Called when the grant is gone. Leaving the route would have every sweep
   * re-attempt a mailbox that cannot be renewed until someone reconnects it,
   * and would keep routing pushes for an account we cannot read. Reconnecting
   * re-creates the route, so this loses nothing recoverable.
   */
  async dropRoute(accountId: string): Promise<void> {
    await withoutTenantScope(this.prisma, 'watch-renewal', async (db) => {
      await db.providerAccountRoute.deleteMany({ where: { accountId } });
    });
  }
}
