import { Injectable, Inject } from '@nestjs/common';
import { AppError } from '@wea/shared';
import { EnvelopeEncryption, LocalKmsProvider, CachingKmsProvider } from '@wea/crypto';
import { GmailProvider, type MailProvider, type ProviderAccount } from '@wea/mail';
import type { Logger } from 'pino';
import { PrismaService } from '../common/prisma.service.js';
import { ConfigService } from '../config/config.service.js';

/**
 * Turning a stored mailbox connection into something that can act on a mailbox.
 *
 * Decryption lives here and nowhere else. The adapters receive plaintext tokens
 * and never touch the database or the KMS, which is what keeps them testable —
 * and keeps the set of places that can decrypt a refresh token down to one.
 */
@Injectable()
export class AccountService {
  private readonly crypto: EnvelopeEncryption;
  private readonly providers = new Map<string, MailProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    // Development uses a static key; production is refused at boot unless a KMS
    // is configured (ADR 0002, enforced in env.schema.ts).
    const kms = new CachingKmsProvider(
      LocalKmsProvider.fromBase64(config.env.ENCRYPTION_MASTER_KEY ?? ''),
    );
    this.crypto = new EnvelopeEncryption(kms);
  }

  /**
   * Loads an account with its tokens decrypted.
   *
   * The AAD binds each ciphertext to `userId:field`, so a token lifted from
   * another user's row fails to decrypt rather than silently granting access to
   * the wrong mailbox.
   */
  async load(userId: string, accountId: string): Promise<ProviderAccount> {
    const account = await this.prisma.forUser(userId, async (tx) =>
      tx.emailAccount.findUnique({ where: { id: accountId } }),
    );

    if (!account) {
      throw new AppError('NOT_FOUND', 'Mailbox connection not found', { retryable: false });
    }

    if (account.status === 'reauth_required' || account.status === 'disconnected') {
      throw new AppError('PROVIDER_UNAUTHORIZED', `Account is ${account.status}`, {
        retryable: false,
        publicMessage: 'We lost access to your mailbox. Please reconnect it.',
      });
    }

    const accessToken = await this.crypto.decryptString(
      {
        ciphertext: Buffer.from(account.accessTokenCipher),
        wrappedKey: Buffer.from(account.accessTokenDek),
        keyVersion: account.tokenKeyVersion,
      },
      { userId, field: 'accessToken' },
    );

    const refreshToken = account.refreshTokenCipher
      ? await this.crypto.decryptString(
          {
            ciphertext: Buffer.from(account.refreshTokenCipher),
            wrappedKey: Buffer.from(account.refreshTokenDek!),
            keyVersion: account.tokenKeyVersion,
          },
          { userId, field: 'refreshToken' },
        )
      : undefined;

    return {
      id: account.id,
      userId,
      emailAddress: account.emailAddress,
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(account.tokenExpiresAt ? { tokenExpiresAt: account.tokenExpiresAt } : {}),
      // Where this mailbox was last synced to. Ingest resumes from here and
      // from nowhere else — a cursor arriving on a job describes the mailbox
      // *now*, and walking history from "now" finds nothing.
      syncCursor: account.syncCursor,
    };
  }

  /** The account a reply should be sent from — the one the email arrived on. */
  async loadForMessage(userId: string, emailMessageId: string): Promise<ProviderAccount> {
    const message = await this.prisma.forUser(userId, async (tx) =>
      tx.emailMessage.findUnique({
        where: { id: emailMessageId },
        select: { accountId: true },
      }),
    );

    if (!message) {
      throw new AppError('NOT_FOUND', 'Email not found', { retryable: false });
    }
    return this.load(userId, message.accountId);
  }

  /** The adapter for a provider, built once and reused. */
  providerFor(kind: string): MailProvider {
    const existing = this.providers.get(kind);
    if (existing) return existing;

    if (kind !== 'gmail') {
      throw new AppError('BAD_REQUEST', `No adapter for provider ${kind}`, { retryable: false });
    }

    const provider = new GmailProvider({
      clientId: this.config.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: this.config.env.GOOGLE_CLIENT_SECRET ?? '',
      redirectUri: this.config.env.GOOGLE_REDIRECT_URI ?? '',
      ...(this.config.env.GOOGLE_PUBSUB_TOPIC
        ? { pubsubTopic: this.config.env.GOOGLE_PUBSUB_TOPIC }
        : {}),
      onTokenRefresh: (accountId, tokens) => this.persistRefreshedToken(accountId, tokens),
    });

    this.providers.set(kind, provider);
    return provider;
  }

  /**
   * Persists a token the provider refreshed mid-flight.
   *
   * Cross-tenant by necessity: the refresh callback fires from inside the OAuth
   * client and carries only the account id. It writes two columns on one row and
   * reads nothing, so the blast radius is the account that just refreshed.
   */
  private async persistRefreshedToken(
    accountId: string,
    tokens: { accessToken: string; expiresAt: Date; refreshToken?: string },
  ): Promise<void> {
    try {
      const owner = await this.prisma.emailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true },
      });
      if (!owner) return;

      const sealed = await this.crypto.encryptString(tokens.accessToken, {
        userId: owner.userId,
        field: 'accessToken',
      });

      await this.prisma.forUser(owner.userId, async (tx) => {
        await tx.emailAccount.update({
          where: { id: accountId },
          data: {
            // Prisma's Bytes is Uint8Array<ArrayBuffer>; Node's Buffer widens
            // to ArrayBufferLike, which does not assign.
            accessTokenCipher: new Uint8Array(sealed.ciphertext),
            accessTokenDek: new Uint8Array(sealed.wrappedKey),
            tokenKeyVersion: sealed.keyVersion,
            tokenExpiresAt: tokens.expiresAt,
          },
        });
      });
    } catch (err) {
      // A failed persist is not fatal — the in-memory token still works for this
      // job, and the next one refreshes again. Logging it matters because a
      // persistent failure here shows up as Google rate-limiting the refresh
      // endpoint, which is a confusing symptom to debug from the other end.
      this.logger.warn(
        { event: 'account.token_persist_failed', accountId, err },
        'Could not persist refreshed access token',
      );
    }
  }

  /**
   * Decrypts a draft body.
   *
   * Exposed here rather than in the draft repository so key material stays in
   * one service. The AAD binds the ciphertext to this user, so a body lifted
   * from another user's draft fails to decrypt rather than being sent from the
   * wrong mailbox.
   */
  decryptBody(
    userId: string,
    sealed: { ciphertext: Buffer; wrappedKey: Buffer; keyVersion: number },
  ): Promise<string> {
    return this.crypto.decryptString(sealed, { userId, field: 'draftBody' });
  }

  /** Encrypts a draft body for storage. */
  async encryptBody(
    userId: string,
    bodyText: string,
  ): Promise<{ ciphertext: Buffer; wrappedKey: Buffer; keyVersion: number }> {
    return this.crypto.encryptString(bodyText, { userId, field: 'draftBody' });
  }

  /**
   * Encrypts a received message body for storage.
   *
   * A different AAD field from a draft body, deliberately. The two are different
   * things with different lifetimes — a received body is purged on the retention
   * schedule, a draft is not — and binding each to its own field means
   * ciphertext moved between the columns fails to decrypt rather than quietly
   * surfacing somewhere it does not belong.
   */
  async encryptMessageBody(
    userId: string,
    bodyText: string,
  ): Promise<{ ciphertext: Buffer; wrappedKey: Buffer; keyVersion: number }> {
    return this.crypto.encryptString(bodyText, { userId, field: 'messageBody' });
  }

  decryptMessageBody(
    userId: string,
    sealed: { ciphertext: Buffer; wrappedKey: Buffer; keyVersion: number },
  ): Promise<string> {
    return this.crypto.decryptString(sealed, { userId, field: 'messageBody' });
  }

  /** Marks an account as needing the user to reconnect. */
  async markReauthRequired(userId: string, accountId: string, reason: string): Promise<void> {
    await this.prisma.forUser(userId, async (tx) => {
      await tx.emailAccount.update({
        where: { id: accountId },
        data: { status: 'reauth_required', lastErrorCode: reason, lastErrorAt: new Date() },
      });
    });
  }
}
