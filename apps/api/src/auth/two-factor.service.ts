import { Injectable, Inject } from '@nestjs/common';
import type { Logger } from 'pino';
import { AppError } from '@wea/shared';
import {
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  matchRecoveryCode,
  verifyPassword,
} from '@wea/crypto';
import { EnvelopeEncryption, createKmsProvider } from '@wea/crypto';
import { PrismaService } from '../common/prisma.service.js';
import { ConfigService } from '../config/config.service.js';
import { SessionService } from './session.service.js';
import { AuditService } from '../common/audit.service.js';

/**
 * The second factor.
 *
 * Two things here are easy to get wrong, and both make an account *less* safe
 * than having no second factor at all.
 *
 * **Enrolment is two steps.** A secret is stored first and `twoFactorEnabled`
 * is set only once the user has produced a working code from it. Enabling on
 * the strength of a secret we generated — without evidence it reached an
 * authenticator app — locks the account out at the next sign-in. That is the
 * precise failure this feature exists to prevent, and it is what the code did
 * before: the schema could say "enabled" while nothing on earth could satisfy
 * it.
 *
 * **Recovery codes are issued at the same moment.** Without them, losing a
 * phone means losing the mailbox. They are shown once, stored only as hashes,
 * and each is spent on use.
 *
 * Everything that checks a code goes through one place, so the replay guard —
 * refusing any step at or below the last one redeemed — cannot be forgotten on
 * one path and remembered on another.
 */

export interface EnrolmentChallenge {
  /** Base32, for a user who cannot scan. */
  secret: string;
  /** What the authenticator app scans. */
  otpauthUri: string;
}

export interface EnrolmentResult {
  /** Shown once. We keep only hashes, so they cannot be re-displayed. */
  recoveryCodes: string[];
}

@Injectable()
export class TwoFactorService {
  private readonly crypto: EnvelopeEncryption;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {
    // `createKmsProvider` is the only place the provider is chosen. Building
    // `LocalKmsProvider` here directly is what made `KMS_PROVIDER` a setting
    // nothing read.
    this.crypto = new EnvelopeEncryption(createKmsProvider(config.env));
  }

  /**
   * Step one: mint a secret and store it, unconfirmed.
   *
   * Deliberately does not enable anything. Re-running it replaces an
   * unconfirmed secret — someone who abandoned enrolment and started again —
   * but refuses to touch a confirmed one, because silently rotating a working
   * second factor would lock the user out of their own account.
   */
  async beginEnrolment(userId: string): Promise<EnrolmentChallenge> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, twoFactorEnabled: true },
    });

    if (!user) throw new AppError('NOT_FOUND', 'No such user');

    if (user.twoFactorEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is already enabled', {
        publicMessage: 'Two-factor authentication is already on. Turn it off first to re-enrol.',
      });
    }

    const secret = generateTotpSecret();
    const sealed = await this.crypto.encryptString(secret, { userId, field: 'twoFactorSecret' });

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecretCipher: new Uint8Array(sealed.ciphertext),
        twoFactorSecretDek: new Uint8Array(sealed.wrappedKey),
        twoFactorSecretKeyVer: sealed.keyVersion,
        twoFactorConfirmedAt: null,
        // A fresh secret means a fresh replay window; the old spent step refers
        // to a key that no longer exists.
        twoFactorLastUsedStep: null,
      },
    });

    this.logger.info({ event: 'auth.2fa_enrolment_started', userId }, 'Two-factor enrolment begun');

    return {
      secret,
      otpauthUri: otpauthUri({
        secret,
        account: user.email,
        // `TOTP_ISSUER` was a setting nothing read: this used a hard-coded
        // constant, so an operator who rebranded still had their users'
        // authenticator apps say "WhatsApp Email Assistant".
        issuer: this.config.env.TOTP_ISSUER,
      }),
    };
  }

  /**
   * Step two: prove the code works, then enable.
   *
   * This is the check that makes enrolment safe. Until it passes,
   * `twoFactorEnabled` stays false and sign-in is unaffected.
   *
   * The session that completed enrolment is marked as having satisfied the
   * second factor, because it just did. Without that, turning 2FA on
   * immediately locks the user out of everything guarded by it: the code they
   * used is now spent, and the next one is up to thirty seconds away.
   */
  async confirmEnrolment(
    userId: string,
    code: string,
    sessionId?: string,
  ): Promise<EnrolmentResult> {
    const user = await this.loadSecret(userId);

    if (user.twoFactorEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is already enabled');
    }

    const verified = verifyTotp(user.secret, code, { lastUsedStep: user.lastUsedStep });
    if (!verified) throw rejected();

    const { codes, hashes } = generateRecoveryCodes();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorConfirmedAt: new Date(),
        twoFactorRecoveryCodes: hashes,
        twoFactorLastUsedStep: BigInt(verified.step),
      },
    });

    // Turning a second factor on or off is the change an account takeover
    // makes first, in either direction — on to lock the owner out, off to keep
    // the door open. Both are recorded.
    await this.audit.record({ action: 'auth.2fa_enabled', userId });

    if (sessionId) await this.sessions.markMfaSatisfied(userId, sessionId);

    this.logger.info({ event: 'auth.2fa_enabled', userId }, 'Two-factor authentication enabled');

    return { recoveryCodes: codes };
  }

  /**
   * Satisfies the second factor for one session.
   *
   * Accepts a TOTP code or a recovery code — a user locked out of their
   * authenticator needs a way in that is not "contact support", and a recovery
   * code they cannot use is not a recovery code.
   *
   * @returns whether a recovery code was spent, so the caller can tell the user
   *   how many remain. Running out silently is how someone discovers they have
   *   none at the worst possible moment.
   */
  async verifyForSession(
    userId: string,
    sessionId: string,
    code: string,
  ): Promise<{ usedRecoveryCode: boolean; recoveryCodesRemaining: number }> {
    const user = await this.loadSecret(userId);

    if (!user.twoFactorEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is not enabled', {
        publicMessage: 'Two-factor authentication is not turned on for this account.',
      });
    }

    const verified = verifyTotp(user.secret, code, { lastUsedStep: user.lastUsedStep });

    if (verified) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorLastUsedStep: BigInt(verified.step) },
      });
      await this.sessions.markMfaSatisfied(userId, sessionId);

      this.logger.info({ event: 'auth.2fa_verified', userId }, 'Second factor satisfied');
      return { usedRecoveryCode: false, recoveryCodesRemaining: user.recoveryCodes.length };
    }

    // Only now try the recovery list. Order matters: a TOTP code cannot match a
    // recovery hash, but attempting recovery first would spend a code on what
    // was really a mistyped TOTP.
    const index = matchRecoveryCode(code, user.recoveryCodes);
    if (index === -1) throw rejected();

    const remaining = user.recoveryCodes.filter((_, i) => i !== index);

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: remaining },
    });
    await this.sessions.markMfaSatisfied(userId, sessionId);

    // Warned about loudly: a recovery code being used is either a lost device
    // or someone else in the account, and both deserve attention.
    this.logger.warn(
      { event: 'auth.2fa_recovery_code_used', userId, remaining: remaining.length },
      'Second factor satisfied with a recovery code',
    );

    return { usedRecoveryCode: true, recoveryCodesRemaining: remaining.length };
  }

  /**
   * Turns it off.
   *
   * Requires the password *and* a current code, because an attacker holding a
   * hijacked session should not be able to strip the factor that is keeping
   * them out of everything else. Every session is revoked afterwards: whoever
   * asked for this can sign in again, and anyone else is removed.
   */
  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.loadSecret(userId);

    if (!user.twoFactorEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is not enabled');
    }

    // Note the argument order: the stored hash comes first. Reversed, this
    // fails closed and silently — the user is simply told their password is
    // wrong forever, and can never turn the factor off.
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password))) {
      throw rejected();
    }

    const verified = verifyTotp(user.secret, code, { lastUsedStep: user.lastUsedStep });
    const recoveryIndex = verified ? -1 : matchRecoveryCode(code, user.recoveryCodes);
    if (!verified && recoveryIndex === -1) throw rejected();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecretCipher: null,
        twoFactorSecretDek: null,
        twoFactorSecretKeyVer: null,
        twoFactorRecoveryCodes: [],
        twoFactorLastUsedStep: null,
        twoFactorConfirmedAt: null,
      },
    });

    await this.sessions.revokeAll(userId, 'two-factor authentication disabled');

    await this.audit.record({ action: 'auth.2fa_disabled', userId });

    this.logger.warn(
      { event: 'auth.2fa_disabled', userId },
      'Two-factor authentication disabled; all sessions revoked',
    );
  }

  /**
   * Loads and decrypts the secret.
   *
   * The one place ciphertext becomes a secret, so the AAD binding it to this
   * user and to `twoFactorSecret` is applied exactly once.
   */
  private async loadSecret(userId: string): Promise<{
    secret: string;
    twoFactorEnabled: boolean;
    lastUsedStep: number | null;
    recoveryCodes: string[];
    passwordHash: string | null;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        twoFactorEnabled: true,
        twoFactorSecretCipher: true,
        twoFactorSecretDek: true,
        twoFactorSecretKeyVer: true,
        twoFactorRecoveryCodes: true,
        twoFactorLastUsedStep: true,
        passwordHash: true,
      },
    });

    if (
      !user?.twoFactorSecretCipher ||
      !user.twoFactorSecretDek ||
      user.twoFactorSecretKeyVer === null
    ) {
      throw new AppError('CONFLICT', 'Two-factor enrolment has not been started', {
        publicMessage: 'Start two-factor setup first.',
      });
    }

    const secret = await this.crypto.decryptString(
      {
        ciphertext: Buffer.from(user.twoFactorSecretCipher),
        wrappedKey: Buffer.from(user.twoFactorSecretDek),
        keyVersion: user.twoFactorSecretKeyVer,
      },
      { userId, field: 'twoFactorSecret' },
    );

    return {
      secret,
      twoFactorEnabled: user.twoFactorEnabled,
      // The column is bigint for 2038; the arithmetic is fine in a double until
      // long after that.
      lastUsedStep: user.twoFactorLastUsedStep === null ? null : Number(user.twoFactorLastUsedStep),
      recoveryCodes: user.twoFactorRecoveryCodes,
      passwordHash: user.passwordHash,
    };
  }
}

/**
 * One rejection for every reason.
 *
 * A wrong code, a replayed code, a wrong password and a spent recovery code all
 * produce this. Distinguishing them tells someone guessing which half of what
 * they hold is correct.
 */
function rejected(): AppError {
  return new AppError('INVALID_CREDENTIALS', 'Two-factor verification failed', {
    publicMessage: "That code isn't right. Try the current one from your authenticator app.",
  });
}
