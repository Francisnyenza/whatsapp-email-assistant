import { Injectable } from '@nestjs/common';
import { withoutTenantScope } from '@wea/db';
import { PrismaService } from '../common/prisma.service.js';

/**
 * The retention sweep's database access.
 *
 * Purging runs on a timer, on behalf of everyone, so it has the same problem
 * every scheduled job here has: no tenant, and row-level security has no way to
 * express one. The answer is the same shape as the watch sweep's — ask the
 * question of a table that carries nothing secret, then do the work scoped.
 *
 * Here that table is `users`, which has no tenant policy because a user *is* the
 * tenant. Enumerating ids from it costs one query and reveals nothing beyond
 * how many accounts exist; every body that is actually erased is erased inside
 * that user's own transaction, under the policy, exactly as a request would.
 */
@Injectable()
export class RetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Every user who might have something to purge. */
  async findUserIds(limit: number, afterId?: string): Promise<string[]> {
    return withoutTenantScope(this.prisma, 'retention-sweep', async (db) => {
      const users = await db.user.findMany({
        where: afterId ? { id: { gt: afterId } } : {},
        // Keyset pagination on the primary key: a sweep that runs for minutes
        // must not skip or repeat users because rows were inserted underneath
        // it, which an OFFSET would do.
        orderBy: { id: 'asc' },
        take: limit,
        select: { id: true },
      });
      return users.map((user) => user.id);
    });
  }

  /**
   * Erases message bodies past the retention window for one user.
   *
   * `bodyPurgedAt` is set in the same statement, so a body that is gone is
   * always a body recorded as having been deliberately removed. Without it the
   * interface cannot tell "we never stored this" from "we erased this on
   * schedule", and would show an empty message either way.
   *
   * Returns how many rows were cleared, so the sweep can keep going while there
   * is more to do rather than trusting a single pass.
   */
  async purgeBodies(userId: string, olderThan: Date, limit: number): Promise<number> {
    return this.prisma.forUser(userId, async (tx) => {
      const stale = await tx.emailMessage.findMany({
        where: {
          receivedAt: { lt: olderThan },
          bodyPurgedAt: null,
          // Only rows that actually hold something. Without this the sweep
          // would keep "purging" the same never-stored messages forever.
          NOT: { bodyTextCipher: null },
        },
        orderBy: { receivedAt: 'asc' },
        take: limit,
        select: { id: true },
      });

      if (stale.length === 0) return 0;

      const cleared = await tx.emailMessage.updateMany({
        where: { id: { in: stale.map((m) => m.id) } },
        data: {
          bodyTextCipher: null,
          bodyHtmlCipher: null,
          bodyDek: null,
          bodyKeyVersion: null,
          bodyPurgedAt: new Date(),
        },
      });

      return cleared.count;
    });
  }
}
