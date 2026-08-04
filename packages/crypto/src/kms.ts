import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '@wea/shared';

/**
 * Key-encryption-key providers.
 *
 * The KEK never leaves the KMS. Everything above this interface deals only in
 * *wrapped* data keys, so swapping AWS KMS for Azure Key Vault or a local key in
 * development changes nothing in the calling code (ADR 0002).
 */

export interface DataKey {
  /** The key material, used immediately and then dropped. */
  plaintext: Buffer;
  /** The same key encrypted under the KEK — this is what gets persisted. */
  wrapped: Buffer;
  /** Which KEK generation wrapped it, so rotation is a re-wrap, not a re-encrypt. */
  keyVersion: number;
}

export interface KmsProvider {
  readonly name: string;
  /** Current KEK generation. Bumped by a rotation. */
  readonly currentKeyVersion: number;
  /** Mints a fresh 256-bit data key, wrapped under the current KEK. */
  generateDataKey(): Promise<DataKey>;
  /** Unwraps a data key produced by `generateDataKey`. */
  unwrapDataKey(wrapped: Buffer, keyVersion: number): Promise<Buffer>;
}

const DEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/**
 * Development and test provider. The KEK is a static 32-byte key from the
 * environment.
 *
 * The boot-time environment check refuses `KMS_PROVIDER=local` in production, so
 * this cannot be reached there — but the interface is identical, which is the
 * point: no code path differs between environments.
 */
export class LocalKmsProvider implements KmsProvider {
  readonly name = 'local';
  readonly currentKeyVersion: number;

  /** keyVersion → KEK, so a rotated environment can still unwrap old records. */
  private readonly keks: Map<number, Buffer>;

  constructor(masterKey: Buffer, previousKeys: Map<number, Buffer> = new Map()) {
    if (masterKey.length !== 32) {
      throw new AppError('ENCRYPTION_FAILURE', 'Master key must be exactly 32 bytes');
    }
    this.currentKeyVersion = Math.max(1, ...previousKeys.keys()) + (previousKeys.size ? 1 : 0);
    this.keks = new Map(previousKeys);
    this.keks.set(this.currentKeyVersion, masterKey);
  }

  static fromBase64(masterKeyBase64: string): LocalKmsProvider {
    const key = Buffer.from(masterKeyBase64, 'base64');
    if (key.length !== 32) {
      throw new AppError(
        'ENCRYPTION_FAILURE',
        'ENCRYPTION_MASTER_KEY must decode to 32 bytes (openssl rand -base64 32)',
      );
    }
    return new LocalKmsProvider(key);
  }

  async generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(DEK_BYTES);
    const kek = this.kek(this.currentKeyVersion);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      plaintext,
      wrapped: Buffer.concat([iv, tag, sealed]),
      keyVersion: this.currentKeyVersion,
    };
  }

  async unwrapDataKey(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    if (wrapped.length <= IV_BYTES + TAG_BYTES) {
      throw new AppError('ENCRYPTION_FAILURE', 'Wrapped data key is truncated');
    }
    const kek = this.kek(keyVersion);

    const iv = wrapped.subarray(0, IV_BYTES);
    const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const sealed = wrapped.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(sealed), decipher.final()]);
    } catch {
      // Never surface the underlying reason: distinguishing "wrong key" from
      // "tampered ciphertext" is an oracle.
      throw new AppError('ENCRYPTION_FAILURE', 'Data key could not be unwrapped');
    }
  }

  private kek(version: number): Buffer {
    const kek = this.keks.get(version);
    if (!kek) {
      throw new AppError('ENCRYPTION_FAILURE', `No key-encryption key for version ${version}`);
    }
    return kek;
  }
}

/**
 * Caches unwrapped data keys.
 *
 * Without it every decrypt is a network round trip to the KMS, which at our read
 * volume is neither affordable nor fast enough. The cost is that plaintext DEKs
 * live in process memory for a bounded window, so the window is deliberately
 * short and the cache deliberately small.
 */
export class CachingKmsProvider implements KmsProvider {
  readonly name: string;
  private readonly cache = new Map<string, { key: Buffer; expiresAt: number }>();

  constructor(
    private readonly inner: KmsProvider,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly maxEntries = 1000,
  ) {
    this.name = `caching(${inner.name})`;
  }

  get currentKeyVersion(): number {
    return this.inner.currentKeyVersion;
  }

  generateDataKey(): Promise<DataKey> {
    // Never cached: a fresh key per record is the entire point of envelope
    // encryption (ADR 0002).
    return this.inner.generateDataKey();
  }

  async unwrapDataKey(wrapped: Buffer, keyVersion: number): Promise<Buffer> {
    const cacheKey = `${keyVersion}:${wrapped.toString('base64')}`;
    const now = Date.now();

    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.key;

    const key = await this.inner.unwrapDataKey(wrapped, keyVersion);

    if (this.cache.size >= this.maxEntries) this.evictOldest();
    this.cache.set(cacheKey, { key, expiresAt: now + this.ttlMs });
    return key;
  }

  /** Drops every cached key. Call on rotation, or on a suspected compromise. */
  clear(): void {
    for (const entry of this.cache.values()) entry.key.fill(0);
    this.cache.clear();
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of this.cache) {
      if (v.expiresAt < oldestAt) {
        oldestAt = v.expiresAt;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      this.cache.get(oldestKey)?.key.fill(0);
      this.cache.delete(oldestKey);
    }
  }
}
