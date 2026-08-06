import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { EnvelopeEncryption, LocalKmsProvider, CachingKmsProvider } from '@wea/crypto';
import { GmailProvider, GMAIL_SCOPES } from '@wea/mail';
import type { Logger } from 'pino';
import { PrismaService } from '../common/prisma.service.js';
import { ConfigService } from '../config/config.service.js';

/**
 * Attaching a mailbox to an account.
 *
 * This is the one place a long-lived refresh token enters the system, so it is
 * the one place that has to get encryption right. Tokens are sealed before they
 * touch the database and are never logged, never returned, and never written to
 * an audit record.
 */
@Injectable()
export class AccountLinkingService {
  private readonly crypto: EnvelopeEncryption;
  readonly gmail: GmailProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    this.crypto = new EnvelopeEncryption(
      new CachingKmsProvider(LocalKmsProvider.fromBase64(config.env.ENCRYPTION_MASTER_KEY ?? '')),
    );

    this.gmail = new GmailProvider({
      clientId: config.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: config.env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri: config.env.GOOGLE_REDIRECT_URI ?? '',
      ...(config.env.GOOGLE_PUBSUB_TOPIC ? { pubsubTopic: config.env.GOOGLE_PUBSUB_TOPIC } : {}),
    });
  }

  consentUrl(state: string): string {
    if (!this.config.env.GOOGLE_CLIENT_ID) {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Google OAuth is not configured', {
        publicMessage: 'Connecting Gmail is not available right now.',
      });
    }
    return this.gmail.authorizationUrl(state, GMAIL_SCOPES);
  }

  /**
   * Completes the flow: exchanges the code, verifies the mailbox, seals the
   * tokens and stores the connection.
   *
   * The account is keyed on `(userId, provider, providerAccountId)`, so
   * reconnecting the same mailbox updates the existing row rather than creating
   * a duplicate — which matters because a user whose grant lapsed will reconnect
   * the same address, and two rows would mean two watches and doubled
   * notifications.
   */
  async completeGoogleLink(
    userId: string,
    code: string,
  ): Promise<{ accountId: string; emailAddress: string }> {
    const tokens = await this.gmail.exchangeCode(code);

    // Confirm the grant works and learn which mailbox it is for, before storing
    // anything. Google returns the address from the token, but asking the API is
    // what proves the scopes were actually granted.
    const identity = await this.gmail.verifyAccess({
      id: 'pending',
      userId,
      emailAddress: '',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiresAt,
    });

    const [accessSealed, refreshSealed] = await Promise.all([
      this.crypto.encryptString(tokens.accessToken, { userId, field: 'accessToken' }),
      this.crypto.encryptString(tokens.refreshToken!, { userId, field: 'refreshToken' }),
    ]);

    const account = await this.prisma.forUser(userId, async (tx) => {
      const existing = await tx.emailAccount.count({ where: {} });

      return tx.emailAccount.upsert({
        where: {
          userId_provider_providerAccountId: {
            userId,
            provider: 'gmail',
            providerAccountId: identity.providerAccountId,
          },
        },
        create: {
          userId,
          provider: 'gmail',
          emailAddress: identity.emailAddress,
          providerAccountId: identity.providerAccountId,
          status: 'connecting',
          accessTokenCipher: new Uint8Array(accessSealed.ciphertext),
          accessTokenDek: new Uint8Array(accessSealed.wrappedKey),
          refreshTokenCipher: new Uint8Array(refreshSealed.ciphertext),
          refreshTokenDek: new Uint8Array(refreshSealed.wrappedKey),
          tokenKeyVersion: accessSealed.keyVersion,
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          // The first mailbox becomes the default for composing.
          isPrimary: existing === 0,
        },
        update: {
          emailAddress: identity.emailAddress,
          status: 'connecting',
          accessTokenCipher: new Uint8Array(accessSealed.ciphertext),
          accessTokenDek: new Uint8Array(accessSealed.wrappedKey),
          refreshTokenCipher: new Uint8Array(refreshSealed.ciphertext),
          refreshTokenDek: new Uint8Array(refreshSealed.wrappedKey),
          tokenKeyVersion: accessSealed.keyVersion,
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          // Clear the failure state — this is a successful reconnect.
          consecutiveFailures: 0,
          lastErrorCode: null,
          disconnectedAt: null,
        },
        select: { id: true, emailAddress: true },
      });
    });

    // The route is what lets an inbound Gmail push find this account. Written
    // outside the tenant transaction because the table is deliberately not
    // tenant-scoped — it is consulted to determine the tenant.
    await this.prisma.providerAccountRoute.upsert({
      where: {
        provider_providerAddress: {
          provider: 'gmail',
          providerAddress: identity.emailAddress.toLowerCase(),
        },
      },
      create: {
        provider: 'gmail',
        providerAddress: identity.emailAddress.toLowerCase(),
        userId,
        accountId: account.id,
      },
      // A mailbox moving between accounts is unusual but legitimate — someone
      // disconnecting and reconnecting under a different login. The expiry is
      // cleared with it: whatever watch the previous account held says nothing
      // about this one, and a stale expiry would read as healthy to the renewal
      // sweep. `startWatching` sets the real value moments later.
      update: { userId, accountId: account.id, watchExpiresAt: null },
    });

    // Note the address is masked by the logger's redaction, so this line is safe
    // even though it names a mailbox.
    this.logger.info(
      { event: 'account.linked', accountId: account.id, provider: 'gmail' },
      'Mailbox connected',
    );

    return { accountId: account.id, emailAddress: account.emailAddress };
  }

  /**
   * Starts push notifications and records the cursor.
   *
   * Deliberately separate from linking and allowed to fail: a mailbox that is
   * connected but not yet watched still works via the polling fallback, whereas
   * failing the whole connect flow over a Pub/Sub misconfiguration would leave
   * the user with nothing and no idea why.
   */
  async startWatching(userId: string, accountId: string): Promise<boolean> {
    try {
      const account = await this.prisma.forUser(userId, async (tx) =>
        tx.emailAccount.findUnique({ where: { id: accountId } }),
      );
      if (!account) return false;

      const accessToken = await this.crypto.decryptString(
        {
          ciphertext: Buffer.from(account.accessTokenCipher),
          wrappedKey: Buffer.from(account.accessTokenDek),
          keyVersion: account.tokenKeyVersion,
        },
        { userId, field: 'accessToken' },
      );

      const handle = await this.gmail.watch({
        id: account.id,
        userId,
        emailAddress: account.emailAddress,
        accessToken,
      });

      await this.prisma.forUser(userId, async (tx) => {
        await tx.emailAccount.update({
          where: { id: accountId },
          data: {
            status: 'active',
            syncCursor: handle.cursor.value,
            watchExpiresAt: handle.expiresAt,
            lastSyncedAt: new Date(),
            pollingSince: null,
          },
        });

        // Mirrored onto the route in the same transaction, because that is what
        // the renewal sweep reads. The two must not diverge: a route that looks
        // healthier than the account is a mailbox that quietly stops receiving
        // mail seven days from now.
        await tx.providerAccountRoute.updateMany({
          where: { accountId },
          data: { watchExpiresAt: handle.expiresAt },
        });
      });

      return true;
    } catch (err) {
      // Fall back to polling rather than failing the connection. The route's
      // expiry stays null, which is exactly what makes the renewal sweep pick
      // this account up first and try again.
      await this.prisma
        .forUser(userId, async (tx) => {
          await tx.emailAccount.update({
            where: { id: accountId },
            data: { status: 'active', pollingSince: new Date(), watchExpiresAt: null },
          });
        })
        .catch(() => undefined);

      this.logger.warn(
        { event: 'account.watch_failed', accountId, err },
        'Could not start push notifications; falling back to polling',
      );
      return false;
    }
  }
}
