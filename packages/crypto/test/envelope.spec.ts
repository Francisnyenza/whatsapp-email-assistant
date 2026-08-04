import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { EnvelopeEncryption, LocalKmsProvider, CachingKmsProvider } from '../src/index.js';
import { AppError } from '@wea/shared';

const ctx = { userId: 'user-1', field: 'refreshToken' };
const otherUser = { userId: 'user-2', field: 'refreshToken' };
const otherField = { userId: 'user-1', field: 'accessToken' };

describe('envelope encryption', () => {
  let kms: LocalKmsProvider;
  let crypto: EnvelopeEncryption;

  beforeEach(() => {
    kms = new LocalKmsProvider(randomBytes(32));
    crypto = new EnvelopeEncryption(kms);
  });

  it('round-trips a value', async () => {
    const secret = 'ya29.a0AfH6SMB-refresh-token-value';
    const sealed = await crypto.encrypt(secret, ctx);
    expect(await crypto.decryptString(sealed, ctx)).toBe(secret);
  });

  it('round-trips binary and unicode content', async () => {
    for (const value of [
      Buffer.from([0x00, 0xff, 0x7f, 0x80]),
      Buffer.from('habari ya asubuhi — 你好 — مرحبا 🎉', 'utf8'),
      Buffer.alloc(0),
      randomBytes(100_000),
    ]) {
      const sealed = await crypto.encrypt(value, ctx);
      expect(Buffer.compare(await crypto.decrypt(sealed, ctx), value)).toBe(0);
    }
  });

  it('never stores the plaintext in the ciphertext', async () => {
    const secret = 'DISTINCTIVE-SECRET-VALUE';
    const sealed = await crypto.encrypt(secret, ctx);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(secret);
    expect(sealed.wrappedKey.toString('utf8')).not.toContain(secret);
  });

  it('produces different ciphertext for the same plaintext every time', async () => {
    // A fresh data key and IV per record. Identical ciphertexts would let anyone
    // holding the database see which users received the same message.
    const a = await crypto.encrypt('same value', ctx);
    const b = await crypto.encrypt('same value', ctx);

    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
    expect(Buffer.compare(a.wrappedKey, b.wrappedKey)).not.toBe(0);
  });

  describe('AAD binding', () => {
    // Without AAD, GCM authenticates the bytes but says nothing about which row
    // they belong to — so a stolen ciphertext could be pasted into another user's
    // record and would decrypt cleanly.

    it('refuses to decrypt under a different user', async () => {
      const sealed = await crypto.encrypt('user 1 token', ctx);
      await expect(crypto.decrypt(sealed, otherUser)).rejects.toThrow(AppError);
    });

    it('refuses to decrypt as a different field', async () => {
      const sealed = await crypto.encrypt('refresh token', ctx);
      await expect(crypto.decrypt(sealed, otherField)).rejects.toThrow(AppError);
    });

    it('requires a context to encrypt at all', async () => {
      await expect(crypto.encrypt('x', { userId: '', field: 'token' })).rejects.toThrow(AppError);
      await expect(crypto.encrypt('x', { userId: 'u', field: '' })).rejects.toThrow(AppError);
    });
  });

  describe('tamper detection', () => {
    it('rejects a modified ciphertext', async () => {
      const sealed = await crypto.encrypt('sensitive', ctx);
      const tampered = Buffer.from(sealed.ciphertext);
      tampered[tampered.length - 1] ^= 0xff;

      await expect(crypto.decrypt({ ...sealed, ciphertext: tampered }, ctx)).rejects.toThrow(
        AppError,
      );
    });

    it('rejects a modified authentication tag', async () => {
      const sealed = await crypto.encrypt('sensitive', ctx);
      const tampered = Buffer.from(sealed.ciphertext);
      tampered[13] ^= 0x01; // inside the tag

      await expect(crypto.decrypt({ ...sealed, ciphertext: tampered }, ctx)).rejects.toThrow(
        AppError,
      );
    });

    it('rejects a swapped wrapped key', async () => {
      const a = await crypto.encrypt('value a', ctx);
      const b = await crypto.encrypt('value b', ctx);

      await expect(crypto.decrypt({ ...a, wrappedKey: b.wrappedKey }, ctx)).rejects.toThrow(
        AppError,
      );
    });

    it('rejects truncated input', async () => {
      const sealed = await crypto.encrypt('value', ctx);
      await expect(
        crypto.decrypt({ ...sealed, ciphertext: sealed.ciphertext.subarray(0, 20) }, ctx),
      ).rejects.toThrow(AppError);
    });
  });

  it('gives the same error for every failure mode', async () => {
    // Distinguishing "wrong key" from "tampered" from "wrong user" is an oracle.
    const sealed = await crypto.encrypt('value', ctx);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] ^= 0xff;

    const messages = await Promise.all(
      [
        () => crypto.decrypt(sealed, otherUser),
        () => crypto.decrypt(sealed, otherField),
        () => crypto.decrypt({ ...sealed, ciphertext: tampered }, ctx),
      ].map(async (fn) => {
        try {
          await fn();
          return 'no error';
        } catch (err) {
          return (err as AppError).message;
        }
      }),
    );

    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('Decryption failed');
  });

  it('cannot be decrypted with a different master key', async () => {
    const sealed = await crypto.encrypt('value', ctx);
    const attacker = new EnvelopeEncryption(new LocalKmsProvider(randomBytes(32)));
    await expect(attacker.decrypt(sealed, ctx)).rejects.toThrow(AppError);
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => new LocalKmsProvider(randomBytes(16))).toThrow(AppError);
    expect(() => LocalKmsProvider.fromBase64(Buffer.alloc(31).toString('base64'))).toThrow(
      AppError,
    );
  });

  describe('key rotation', () => {
    it('re-wraps under the new generation while old records still decrypt', async () => {
      const oldKek = randomBytes(32);
      const oldKms = new LocalKmsProvider(oldKek);
      const oldCrypto = new EnvelopeEncryption(oldKms);
      const sealed = await oldCrypto.encrypt('long-lived refresh token', ctx);

      // A rotated deployment keeps prior generations so nothing becomes
      // unreadable at the moment of rotation.
      const rotatedKms = new LocalKmsProvider(randomBytes(32), new Map([[1, oldKek]]));
      const rotated = new EnvelopeEncryption(rotatedKms);

      expect(await rotated.decryptString(sealed, ctx)).toBe('long-lived refresh token');

      const reWrapped = await rotated.rotate(sealed, ctx);
      expect(reWrapped.keyVersion).toBe(rotatedKms.currentKeyVersion);
      expect(reWrapped.keyVersion).not.toBe(sealed.keyVersion);
      expect(await rotated.decryptString(reWrapped, ctx)).toBe('long-lived refresh token');
    });

    it('is a no-op when already current', async () => {
      const sealed = await crypto.encrypt('value', ctx);
      expect(await crypto.rotate(sealed, ctx)).toBe(sealed);
    });

    it('fails loudly when the old key generation is gone', async () => {
      const sealed = await crypto.encrypt('value', ctx);
      const withoutHistory = new EnvelopeEncryption(new LocalKmsProvider(randomBytes(32)));
      // Better an error than silently returning wrong plaintext.
      await expect(withoutHistory.decrypt({ ...sealed, keyVersion: 99 }, ctx)).rejects.toThrow(
        AppError,
      );
    });
  });
});

describe('data key caching', () => {
  it('serves repeat unwraps from cache without changing the result', async () => {
    let unwrapCalls = 0;
    const inner = new LocalKmsProvider(randomBytes(32));
    const counting = {
      name: 'counting',
      get currentKeyVersion() {
        return inner.currentKeyVersion;
      },
      generateDataKey: () => inner.generateDataKey(),
      unwrapDataKey: (w: Buffer, v: number) => {
        unwrapCalls++;
        return inner.unwrapDataKey(w, v);
      },
    };

    const crypto = new EnvelopeEncryption(new CachingKmsProvider(counting));
    const sealed = await crypto.encrypt('value', ctx);

    expect(await crypto.decryptString(sealed, ctx)).toBe('value');
    expect(await crypto.decryptString(sealed, ctx)).toBe('value');
    expect(await crypto.decryptString(sealed, ctx)).toBe('value');

    expect(unwrapCalls).toBe(1);
  });

  it('never caches generated data keys', async () => {
    // A cached data key would mean two records sharing one — the opposite of
    // what envelope encryption is for.
    const caching = new CachingKmsProvider(new LocalKmsProvider(randomBytes(32)));
    const a = await caching.generateDataKey();
    const b = await caching.generateDataKey();
    expect(Buffer.compare(a.plaintext, b.plaintext)).not.toBe(0);
  });

  it('honours the TTL', async () => {
    let unwrapCalls = 0;
    const inner = new LocalKmsProvider(randomBytes(32));
    const counting = {
      name: 'counting',
      get currentKeyVersion() {
        return inner.currentKeyVersion;
      },
      generateDataKey: () => inner.generateDataKey(),
      unwrapDataKey: (w: Buffer, v: number) => {
        unwrapCalls++;
        return inner.unwrapDataKey(w, v);
      },
    };

    const caching = new CachingKmsProvider(counting, 0);
    const crypto = new EnvelopeEncryption(caching);
    const sealed = await crypto.encrypt('value', ctx);

    await crypto.decrypt(sealed, ctx);
    await crypto.decrypt(sealed, ctx);
    expect(unwrapCalls).toBe(2);
  });
});
