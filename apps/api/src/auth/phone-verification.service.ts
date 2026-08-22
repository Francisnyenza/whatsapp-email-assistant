import { Injectable, Inject } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { AppError, normalizePhone } from '@wea/shared';
import type { Logger } from 'pino';
import { PrismaService } from '../common/prisma.service.js';
import { AuditService } from '../common/audit.service.js';

/**
 * Proving a phone number belongs to the person claiming it.
 *
 * This number decides where a user's private email is delivered, and until now
 * nothing proved it. `phone_verified` existed from the first migration and was
 * read by no code, which made three things true at once: a typo at signup sent
 * someone's inbox summaries to a stranger's phone; the `UNIQUE` constraint meant
 * claiming a number you did not own also squatted it, so the real owner could
 * never register; and an inbound WhatsApp message resolved to whoever claimed
 * the number, so the squatter's mailbox was the one a victim's messages acted on.
 *
 * The flow runs **inbound**, which is not the obvious direction and is the right
 * one. We show the user a code; they send it to our WhatsApp number from their
 * own phone. That proves possession without needing an approved template — we
 * cannot send a free-form message to a number that has never messaged us — and
 * it opens the 24-hour customer service window at the same moment, which is the
 * window the very first notification needs anyway.
 */
@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject('LOGGER') private readonly logger: Logger,
  ) {}

  /**
   * Issues a code for the user to send us.
   *
   * Returns it in plaintext exactly once, to the authenticated user who asked.
   * Only the hash is stored — this is a bearer credential that binds a phone
   * number to an account, and a leaked database should not let anyone claim one.
   */
  async start(userId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneVerificationCodeHash: hashCode(code),
        phoneVerificationExpiresAt: expiresAt,
      },
    });

    this.logger.info(
      { event: 'phone.verification_started', userId },
      'Phone verification code issued',
    );

    return { code, expiresAt };
  }

  /**
   * Redeems a code sent from a phone we have not seen before.
   *
   * Called from the inbound WhatsApp path, which has no tenant — the whole point
   * is that we do not yet know who this number belongs to. The lookup is by code
   * hash, which is why that column is unique: two users must never hold the same
   * live code, or redeeming one would be ambiguous.
   *
   * @returns the user the number was linked to, or null when the text was not a
   *   live code — which is the ordinary case for a message from a stranger.
   */
  async redeem(
    rawCode: string,
    rawPhoneNumber: string,
  ): Promise<{ userId: string; phoneNumber: string } | null> {
    const code = normalizeCode(rawCode);
    if (!code) return null;

    const phoneNumber = normalizePhone(rawPhoneNumber);
    if (!phoneNumber) return null;

    const user = await this.prisma.user.findFirst({
      where: {
        phoneVerificationCodeHash: hashCode(code),
        phoneVerificationExpiresAt: { gt: new Date() },
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!user) return null;

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          phoneNumber,
          phoneVerified: true,
          // Spent. A code that survived redemption could link a second account
          // to the same phone the moment the first one released it.
          phoneVerificationCodeHash: null,
          phoneVerificationExpiresAt: null,
        },
      });
    } catch (err) {
      // The number is already verified against another account. Refused rather
      // than moved: two accounts sharing a WhatsApp number would make every
      // inbound message ambiguous, and silently reassigning it would let anyone
      // who can send one message take a number away from its current owner.
      if (isUniqueViolation(err)) {
        this.logger.warn(
          { event: 'phone.verification_conflict', userId: user.id },
          'Code redeemed for a number already linked to another account',
        );
        throw new AppError('CONFLICT', 'Phone number already linked to another account', {
          publicMessage:
            'That number is already connected to a different account. Disconnect it there first.',
          retryable: false,
        });
      }
      throw err;
    }

    this.logger.info(
      { event: 'phone.verified', userId: user.id },
      'Phone number verified and linked',
    );

    // The number is where every notification goes and where every command is
    // accepted from, so linking one is a change to who can act on this account.
    // The number itself stays out of the entry — the logger masks it, and the
    // audit table should not become the one place it is stored in clear.
    await this.audit.record({ action: 'auth.phone_verified', userId: user.id });

    return { userId: user.id, phoneNumber };
  }

  /** What the settings screen shows: linked or not, and whether a code is live. */
  async status(
    userId: string,
  ): Promise<{ phoneNumber: string | null; verified: boolean; codePending: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phoneNumber: true,
        phoneVerified: true,
        phoneVerificationExpiresAt: true,
      },
    });

    if (!user) throw new AppError('NOT_FOUND', 'User not found');

    return {
      phoneNumber: user.phoneNumber,
      verified: user.phoneVerified,
      codePending: (user.phoneVerificationExpiresAt?.getTime() ?? 0) > Date.now(),
    };
  }

  /**
   * Unlinks the number.
   *
   * Clears the verified flag with it, because a number that is no longer ours to
   * send to must not read as proved if it is ever re-attached by a migration or
   * a restore.
   */
  async unlink(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber: null,
        phoneVerified: false,
        phoneVerificationCodeHash: null,
        phoneVerificationExpiresAt: null,
      },
    });

    this.logger.info({ event: 'phone.unlinked', userId }, 'Phone number unlinked');
  }
}

/**
 * Ten minutes. Long enough to switch apps and type eight characters, short
 * enough that a code read over someone's shoulder is not useful later.
 */
const CODE_TTL_MS = 10 * 60_000;

/**
 * The alphabet, minus everything that is ambiguous when read off a screen and
 * typed into a phone: no O/0, no I/1/L, no U (which becomes V in some fonts).
 * Eight characters from 29 symbols is about 39 bits — far beyond guessing at
 * one attempt per WhatsApp message.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateCode(): string {
  let code = '';
  // `randomInt` rather than `Math.random`: this is a credential.
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/**
 * The code as the user actually sent it.
 *
 * People add spaces, use lower case, and type O for 0. The last of those is why
 * the alphabet excludes both — a substitution here would silently accept a code
 * that was never issued.
 */
function normalizeCode(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return /^[2-9A-HJ-NP-Z]{8}$/.test(cleaned) ? cleaned : null;
}

/**
 * SHA-256, not Argon2id.
 *
 * A password is low-entropy and needs the work factor; this code is 39 random
 * bits with a ten-minute life, so a fast hash gives nothing to an offline
 * attacker — and it has to be *looked up* by value from an inbound message,
 * which a salted hash cannot do.
 */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err) && (err as { code?: string }).code === 'P2002';
}
