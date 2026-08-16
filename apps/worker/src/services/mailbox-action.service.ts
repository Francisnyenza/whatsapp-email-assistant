import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError, type MailOperation } from '@wea/shared';
import { PrismaService } from '../common/prisma.service.js';
import { AccountService } from './account.service.js';

/**
 * Acting on a mailbox.
 *
 * Everything here is an operation the user has already authorized — by typing a
 * verb, or by tapping a button carrying a server-minted id. This service does
 * not decide *whether* to act; it acts, and reports honestly whether it worked.
 *
 * The ordering is the substance:
 *
 *  1. **The provider first.** Gmail is the source of truth for what is in the
 *     mailbox. Writing our own flag first and then failing upstream would leave
 *     the user's phone claiming a state their inbox does not have — and the next
 *     sync would silently undo it, so even the discrepancy would vanish.
 *  2. **Then the local mirror**, so lists and the resolver stop offering a
 *     message the user has already dealt with.
 *
 * If step 2 fails after step 1 succeeded, the mailbox is right and our copy is
 * stale — which the next sync repairs. That is the correct way round for this
 * pair to fail.
 */
@Injectable()
export class MailboxActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Applies one operation to one message.
   *
   * @throws {AppError} when the message is unknown, or when the provider
   *   refuses. Callers are expected to turn that into something the user reads,
   *   rather than reporting success anyway.
   */
  async apply(userId: string, emailMessageId: string, operation: MailOperation): Promise<void> {
    const message = await this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: { id: true, accountId: true, providerMessageId: true, deletedAt: true },
      }),
    );

    if (!message) {
      throw new AppError('NOT_FOUND', 'That email is no longer available', { retryable: false });
    }

    if (message.deletedAt && operation.kind !== 'delete') {
      // Acting on something already in the trash would appear to work and then
      // not be there. Better to say so.
      throw new AppError('CONFLICT', 'That email has already been deleted', { retryable: false });
    }

    const account = await this.accounts.load(userId, message.accountId);
    const provider = this.accounts.providerFor(account.provider);

    await provider.mutate(account, message.providerMessageId, operation);

    await this.mirror(userId, emailMessageId, operation);

    this.logger.info(
      { event: 'mailbox.mutated', emailMessageId, operation: operation.kind },
      'Mailbox operation applied',
    );
  }

  /**
   * Reflects an applied operation in our own copy.
   *
   * Best-effort by design: the provider has already accepted the change, so
   * failing here must not report failure to the user or trigger a retry that
   * would re-apply it. The next sync reconciles.
   */
  private async mirror(
    userId: string,
    emailMessageId: string,
    operation: MailOperation,
  ): Promise<void> {
    const data = localEffectOf(operation);
    if (!data) return;

    try {
      await this.prisma.forUser(userId, async (tx) => {
        await tx.emailMessage.update({ where: { id: emailMessageId }, data });
      });
    } catch (err) {
      this.logger.warn(
        { event: 'mailbox.mirror_failed', emailMessageId, operation: operation.kind, err },
        'Applied upstream but could not update the local copy; the next sync will reconcile',
      );
    }
  }
}

/** How an operation shows up in our own row. Null when it has no local effect. */
function localEffectOf(operation: MailOperation): Record<string, unknown> | null {
  switch (operation.kind) {
    case 'archive':
      return { isArchived: true };
    case 'delete':
      return { deletedAt: new Date() };
    case 'markRead':
      return { isUnread: !operation.read };
    case 'star':
      return { isStarred: operation.starred };
    case 'spam':
      return { isSpam: operation.isSpam };
    case 'label':
      // Labels are reconciled from the provider on the next sync rather than
      // guessed at here; a partial local view of them would be worse than none.
      return null;
    default:
      return null;
  }
}
