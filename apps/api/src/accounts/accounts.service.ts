import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { EnvelopeEncryption, createKmsProvider } from '@wea/crypto';
import { GmailProvider, GraphProvider, type MailProvider } from '@wea/mail';
import type { Logger } from 'pino';
import { PrismaService } from '../common/prisma.service.js';
import { ConfigService } from '../config/config.service.js';

/**
 * The mailboxes a user has connected.
 *
 * Everything here is a read or a disconnect — nothing in this service can touch
 * mail. That is deliberate: the dashboard needs to show what is connected and
 * let someone take it away, and neither of those should reach the mailbox.
 *
 * The one thing that does reach a provider is `disconnect`, which cancels the
 * push subscription. It is allowed to fail without failing the disconnect, for
 * the same reason `startWatching` is allowed to fail without failing a connect:
 * leaving a user unable to remove a mailbox because a third party is having a
 * bad afternoon is worse than a subscription that lapses on its own in three
 * days.
 */
@Injectable()
export class AccountsService {
  private readonly crypto: EnvelopeEncryption;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    // `createKmsProvider` is the only place the provider is chosen. Building
    // `LocalKmsProvider` here directly is what made `KMS_PROVIDER` a setting
    // nothing read.
    this.crypto = new EnvelopeEncryption(createKmsProvider(config.env));
  }

  /**
   * What the settings screen shows.
   *
   * No tokens, no cursors, no subscription ids — a mailbox list is not a place
   * to leak the shape of our sync state, and a UI has no use for any of it. What
   * it does carry is *why* a mailbox is unhealthy, because "reconnect" and "we
   * are polling this one" are different messages and a user can act on the first.
   */
  async list(userId: string): Promise<ConnectedAccount[]> {
    const accounts = await this.prisma.forUser(userId, async (tx) =>
      tx.emailAccount.findMany({
        where: { disconnectedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          provider: true,
          emailAddress: true,
          status: true,
          isPrimary: true,
          lastSyncedAt: true,
          lastErrorCode: true,
          pollingSince: true,
          watchExpiresAt: true,
          createdAt: true,
        },
      }),
    );

    return accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      emailAddress: account.emailAddress,
      isPrimary: account.isPrimary,
      connectedAt: account.createdAt,
      lastSyncedAt: account.lastSyncedAt,
      health: health(account),
    }));
  }

  /**
   * Removes a mailbox.
   *
   * Marked disconnected rather than deleted, and that is not squeamishness. The
   * delivery records that resolve a user's next WhatsApp reply point at messages
   * on this account; deleting the row would cascade them away and turn every
   * outstanding notification into a reply that resolves to nothing. The
   * retention sweep clears the mail on its own schedule.
   *
   * The route goes immediately, though — that is what stops inbound pushes for a
   * mailbox we no longer act on.
   */
  async disconnect(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.forUser(userId, async (tx) =>
      tx.emailAccount.findUnique({ where: { id: accountId } }),
    );

    if (!account || account.disconnectedAt) {
      throw new AppError('NOT_FOUND', 'Mailbox connection not found', {
        publicMessage: 'That mailbox is not connected.',
      });
    }

    await this.stopWatching(userId, account);

    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: {
          status: 'disconnected',
          disconnectedAt: new Date(),
          // The grant is being given up, so the tokens are no longer ours to
          // hold. Clearing them is the difference between a disconnect and a
          // pause.
          accessTokenCipher: new Uint8Array(),
          accessTokenDek: new Uint8Array(),
          refreshTokenCipher: null,
          refreshTokenDek: null,
          watchExpiresAt: null,
          watchSubscriptionId: null,
          pollingSince: null,
        },
      });
    });

    // Outside the tenant transaction, because the routing table deliberately is
    // not tenant-scoped — it is consulted to *determine* the tenant.
    await this.prisma.providerAccountRoute.deleteMany({ where: { accountId } });

    this.logger.info(
      { event: 'account.disconnected', accountId, provider: account.provider },
      'Mailbox disconnected',
    );
  }

  /**
   * Cancels the push subscription, and does not mind failing.
   *
   * A revoked grant cannot be used to cancel anything, which is precisely the
   * case where a user is most likely to be disconnecting — so a failure here is
   * the expected path as often as not. Both providers expire subscriptions on
   * their own within days.
   */
  private async stopWatching(
    userId: string,
    account: {
      id: string;
      provider: string;
      emailAddress: string;
      accessTokenCipher: Uint8Array;
      accessTokenDek: Uint8Array;
      tokenKeyVersion: number;
      watchSubscriptionId: string | null;
    },
  ): Promise<void> {
    try {
      const accessToken = await this.crypto.decryptString(
        {
          ciphertext: Buffer.from(account.accessTokenCipher),
          wrappedKey: Buffer.from(account.accessTokenDek),
          keyVersion: account.tokenKeyVersion,
        },
        { userId, field: 'accessToken' },
      );

      await this.providerFor(account.provider).stopWatch({
        id: account.id,
        provider: account.provider,
        userId,
        emailAddress: account.emailAddress,
        accessToken,
        ...(account.watchSubscriptionId
          ? { config: { subscriptionId: account.watchSubscriptionId } }
          : {}),
      });
    } catch (err) {
      this.logger.warn(
        { event: 'account.stop_watch_failed', accountId: account.id, err },
        'Could not cancel the push subscription; it will lapse on its own',
      );
    }
  }

  private providerFor(kind: string): MailProvider {
    const env = this.config.env;

    if (kind === 'gmail') {
      return new GmailProvider({
        clientId: env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirectUri: env.GOOGLE_REDIRECT_URI ?? '',
      });
    }

    return new GraphProvider({
      clientId: env.MICROSOFT_CLIENT_ID ?? '',
      clientSecret: env.MICROSOFT_CLIENT_SECRET ?? '',
      redirectUri: env.MICROSOFT_REDIRECT_URI ?? '',
      tenantId: env.MICROSOFT_TENANT_ID,
    });
  }
}

export interface ConnectedAccount {
  id: string;
  provider: string;
  emailAddress: string;
  isPrimary: boolean;
  connectedAt: Date;
  lastSyncedAt: Date | null;
  health: AccountHealth;
}

/**
 * How a mailbox is doing, in terms a person can act on.
 *
 * Three states rather than the raw status column, because the raw column mixes
 * things a user should respond to with things they should ignore. `reconnect`
 * is the only one that needs them; `degraded` is us working around a provider
 * problem and is worth showing but not worth alarming about.
 */
export type AccountHealth =
  | { state: 'healthy' }
  | { state: 'degraded'; reason: 'polling' }
  | { state: 'reconnect'; reason: string };

function health(account: {
  status: string;
  lastErrorCode: string | null;
  pollingSince: Date | null;
}): AccountHealth {
  if (account.status === 'reauth_required' || account.status === 'disconnected') {
    return { state: 'reconnect', reason: account.lastErrorCode ?? account.status };
  }

  if (account.pollingSince) {
    // Push could not be established. Mail still arrives, a couple of minutes
    // later than it would otherwise — worth showing, not worth alarming about.
    return { state: 'degraded', reason: 'polling' };
  }

  return { state: 'healthy' };
}
