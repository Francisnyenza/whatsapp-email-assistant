import { describe, it, expect } from 'vitest';
import { createKmsProvider, UNIMPLEMENTED_KMS_PROVIDERS } from '../src/kms-factory.js';

/**
 * Choosing where the key-encryption key comes from.
 *
 * These tests exist because the choice was not being made. Four call sites each
 * constructed `LocalKmsProvider` directly, so `KMS_PROVIDER` was a setting
 * nothing read — and the failure that mattered was not the loud one.
 *
 * With a managed provider named and no master key, the process died at boot:
 * annoying, but visible. With a managed provider named **and** a master key
 * present — which is what copying `.env.example` gives you — it started
 * happily on a static key from its own environment while the operator believed
 * the KEK lived in a managed service. ADR 0002 exists to prevent exactly that,
 * so the test that matters most here is the one asserting a refusal where a
 * fallback would have worked.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');

describe('a local provider', () => {
  it('is built from the master key', () => {
    const kms = createKmsProvider({ KMS_PROVIDER: 'local', ENCRYPTION_MASTER_KEY: KEY });

    expect(kms).toBeDefined();
    expect(typeof kms.generateDataKey).toBe('function');
  });

  it('actually wraps and unwraps, so the wiring is real', async () => {
    const kms = createKmsProvider({ KMS_PROVIDER: 'local', ENCRYPTION_MASTER_KEY: KEY });

    const key = await kms.generateDataKey();
    const unwrapped = await kms.unwrapDataKey(key.wrapped, key.keyVersion);

    expect(unwrapped.equals(key.plaintext)).toBe(true);
  });

  it('refuses at boot when the master key is missing', () => {
    expect(() => createKmsProvider({ KMS_PROVIDER: 'local' })).toThrow(/ENCRYPTION_MASTER_KEY/);
  });

  it('refuses a master key of the wrong length', () => {
    expect(() =>
      createKmsProvider({ KMS_PROVIDER: 'local', ENCRYPTION_MASTER_KEY: 'dG9vLXNob3J0' }),
    ).toThrow(/32 bytes/);
  });
});

describe('a managed provider', () => {
  it.each(UNIMPLEMENTED_KMS_PROVIDERS)('refuses rather than pretending: %s', (provider) => {
    expect(() => createKmsProvider({ KMS_PROVIDER: provider, KMS_KEY_ID: 'x' })).toThrow(
      /not implemented/,
    );
  });

  it('does not fall back to the master key when one happens to be set', () => {
    // The whole point. A fallback here is the same bug wearing a friendlier
    // face: the process starts, everything works, and the key-encryption key is
    // sitting in the environment of a deployment whose operator was told it was
    // in a managed service.
    expect(() =>
      createKmsProvider({
        KMS_PROVIDER: 'azure',
        KMS_KEY_ID: 'https://vault.example/keys/wea',
        ENCRYPTION_MASTER_KEY: KEY,
      }),
    ).toThrow(/not implemented/);
  });

  it('says which providers do work', () => {
    try {
      createKmsProvider({ KMS_PROVIDER: 'gcp', KMS_KEY_ID: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/"local" and "aws"/);
      expect((err as Error).message).toMatch(/ADR 0002/);
    }
  });
});

describe('aws', () => {
  it('builds a provider', () => {
    // Constructing the SDK client opens no connection, so this needs neither
    // credentials nor a network — the first call would, and there is none here.
    const kms = createKmsProvider({
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'arn:aws:kms:eu-west-1:000000000000:key/abc',
    });

    expect(kms.name).toBe('caching(aws)');
  });

  it('is cached, so a decrypt is not a KMS call every time', () => {
    // ADR 0002 names this explicitly: without the cache, every read of an
    // encrypted column is a billed round trip to KMS.
    const kms = createKmsProvider({ KMS_PROVIDER: 'aws', KMS_KEY_ID: 'k' });

    expect(kms.name).toMatch(/^caching\(/);
  });

  it('refuses without a key id, naming what a key id looks like', () => {
    expect(() => createKmsProvider({ KMS_PROVIDER: 'aws' })).toThrow(/KMS_KEY_ID/);
  });

  it('does not quietly use the master key when the key id is missing', () => {
    // The dangerous shape again: aws named, no key id, but a local key present.
    expect(() => createKmsProvider({ KMS_PROVIDER: 'aws', ENCRYPTION_MASTER_KEY: KEY })).toThrow(
      /KMS_KEY_ID/,
    );
  });
});
