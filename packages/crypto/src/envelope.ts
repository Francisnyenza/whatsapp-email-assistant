import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '@wea/shared';
import type { KmsProvider } from './kms.js';

/**
 * Envelope encryption for data at rest (ADR 0002).
 *
 * Each record gets its own data key. The plaintext is sealed with AES-256-GCM,
 * and the data key is stored alongside it, wrapped under a KEK that never leaves
 * the KMS. A database dump on its own is therefore useless.
 *
 * Two properties are worth calling out because they are easy to omit and
 * expensive to add later:
 *
 *  * **AAD binds ciphertext to its row.** Every payload is authenticated against
 *    `userId:field`, so a stolen `refresh_token_cipher` cannot be pasted into
 *    another user's row — the tag check fails. Without AAD, GCM authenticates
 *    the bytes but says nothing about where they belong.
 *  * **Decryption failures are indistinguishable.** Wrong key, tampered
 *    ciphertext, and mismatched AAD all raise the same error with the same
 *    message. Any difference is an oracle.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * What gets persisted. The three columns always travel together — a database
 * CHECK constraint rejects a row carrying ciphertext without its key.
 */
export interface EncryptedPayload {
  /** `iv || tag || ciphertext` */
  ciphertext: Buffer;
  /** The data key, wrapped under the KEK. */
  wrappedKey: Buffer;
  keyVersion: number;
}

/**
 * Binds a ciphertext to the record and field it belongs to.
 *
 * `field` must name the column, not its value — `'refreshToken'`, not the token.
 */
export interface EncryptionContext {
  userId: string;
  field: string;
}

function aad(context: EncryptionContext): Buffer {
  return Buffer.from(`${context.userId}:${context.field}`, 'utf8');
}

export class EnvelopeEncryption {
  constructor(private readonly kms: KmsProvider) {}

  async encrypt(plaintext: Buffer | string, context: EncryptionContext): Promise<EncryptedPayload> {
    if (!context.userId || !context.field) {
      // Encrypting without a binding context is a silent downgrade in security,
      // so it is a programming error rather than a permitted shortcut.
      throw new AppError('ENCRYPTION_FAILURE', 'Encryption context requires userId and field');
    }

    const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const dataKey = await this.kms.generateDataKey();

    try {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv);
      cipher.setAAD(aad(context));

      const sealed = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();

      return {
        ciphertext: Buffer.concat([iv, tag, sealed]),
        wrappedKey: dataKey.wrapped,
        keyVersion: dataKey.keyVersion,
      };
    } finally {
      // The wrapped copy is what persists; the plaintext key has no further use.
      dataKey.plaintext.fill(0);
    }
  }

  async decrypt(payload: EncryptedPayload, context: EncryptionContext): Promise<Buffer> {
    // An empty plaintext seals to exactly IV + tag, which is valid: an email can
    // legitimately have an empty body.
    if (payload.ciphertext.length < IV_BYTES + TAG_BYTES) {
      throw new AppError('ENCRYPTION_FAILURE', 'Ciphertext is truncated');
    }

    const key = await this.kms.unwrapDataKey(payload.wrappedKey, payload.keyVersion);

    const iv = payload.ciphertext.subarray(0, IV_BYTES);
    const tag = payload.ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const sealed = payload.ciphertext.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(sealed), decipher.final()]);
    } catch {
      // One message for every failure mode. See the class comment.
      throw new AppError('ENCRYPTION_FAILURE', 'Decryption failed');
    }
  }

  async encryptString(plaintext: string, context: EncryptionContext): Promise<EncryptedPayload> {
    return this.encrypt(Buffer.from(plaintext, 'utf8'), context);
  }

  async decryptString(payload: EncryptedPayload, context: EncryptionContext): Promise<string> {
    return (await this.decrypt(payload, context)).toString('utf8');
  }

  /**
   * Re-encrypts under the current KEK generation.
   *
   * Used by the rotation job: it decrypts with the old key version and writes
   * back with the new one. Callers persist the returned payload; nothing is
   * rotated in place.
   */
  async rotate(payload: EncryptedPayload, context: EncryptionContext): Promise<EncryptedPayload> {
    if (payload.keyVersion === this.kms.currentKeyVersion) return payload;
    const plaintext = await this.decrypt(payload, context);
    try {
      return await this.encrypt(plaintext, context);
    } finally {
      plaintext.fill(0);
    }
  }
}
