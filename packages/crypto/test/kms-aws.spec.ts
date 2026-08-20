import { describe, it, expect, vi } from 'vitest';
import { AwsKmsProvider, AWS_KEY_VERSION, type KmsCryptoApi } from '../src/kms-aws.js';
import { EnvelopeEncryption } from '../src/envelope.js';

/**
 * AWS KMS as the key-encryption key.
 *
 * Tested against a fake `KmsCryptoApi` rather than AWS, which is the same
 * arrangement the Gmail and Graph adapters use: what can be checked offline is
 * how this class behaves given a response, and that is where its decisions live
 * — whether a throttle is worth retrying, what happens to a 200 that carries no
 * key material, and whether a wrapped key round-trips through the envelope layer
 * above it.
 *
 * What is *not* checked here is that AWS behaves as assumed. Nobody has pointed
 * this at a real CMK; `docs/status.md` says so.
 */

function fakeKms(overrides: Partial<KmsCryptoApi> = {}): KmsCryptoApi {
  return {
    generateDataKey: vi.fn(async () => ({
      Plaintext: new Uint8Array(Buffer.alloc(32, 3)),
      CiphertextBlob: new Uint8Array(Buffer.from('wrapped-by-kms')),
    })),
    decrypt: vi.fn(async () => ({ Plaintext: new Uint8Array(Buffer.alloc(32, 3)) })),
    ...overrides,
  };
}

/** An SDK-shaped error: the kind is in `name`, which is what the mapping reads. */
function kmsError(name: string, message = 'boom'): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('minting a data key', () => {
  it('asks for AES-256 under the configured key', async () => {
    const kms = fakeKms();
    await new AwsKmsProvider(kms, 'alias/wea').generateDataKey();

    expect(kms.generateDataKey).toHaveBeenCalledWith({
      KeyId: 'alias/wea',
      KeySpec: 'AES_256',
    });
  });

  it('returns the plaintext for immediate use and the blob to persist', async () => {
    const key = await new AwsKmsProvider(fakeKms(), 'alias/wea').generateDataKey();

    expect(key.plaintext).toEqual(Buffer.alloc(32, 3));
    expect(key.wrapped.toString()).toBe('wrapped-by-kms');
    expect(key.keyVersion).toBe(AWS_KEY_VERSION);
  });

  it('refuses a response missing its key material', async () => {
    // Continuing here would encrypt real correspondence under a zero-length
    // key, which is worse in every way than failing the request.
    const kms = fakeKms({
      generateDataKey: vi.fn(async () => ({ CiphertextBlob: new Uint8Array(4) })),
    });

    await expect(new AwsKmsProvider(kms, 'k').generateDataKey()).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILURE',
      retryable: false,
    });
  });

  it('refuses a data key of the wrong length', async () => {
    // AES-256 needs exactly 32 bytes. A shorter key would be padded or rejected
    // deep inside `createCipheriv`, a long way from the cause.
    const kms = fakeKms({
      generateDataKey: vi.fn(async () => ({
        Plaintext: new Uint8Array(16),
        CiphertextBlob: new Uint8Array(4),
      })),
    });

    await expect(new AwsKmsProvider(kms, 'k').generateDataKey()).rejects.toThrow(/16-byte/);
  });
});

describe('unwrapping', () => {
  it('names the key, so a blob from another CMK is refused rather than decrypted', async () => {
    // Without `KeyId`, KMS decrypts whatever the blob says it belongs to. That
    // turns "an attacker supplied their own wrapped key" into a successful
    // decrypt.
    const kms = fakeKms();
    await new AwsKmsProvider(kms, 'alias/wea').unwrapDataKey(Buffer.from('blob'), 1);

    expect(kms.decrypt).toHaveBeenCalledWith({
      CiphertextBlob: Buffer.from('blob'),
      KeyId: 'alias/wea',
    });
  });

  it('ignores the key version it is handed', async () => {
    // The blob names its own key material, so rotation is KMS's business. A
    // record written before a rotation still decrypts after one — which is the
    // property the local provider needs a generation map to keep.
    const kms = fakeKms();
    const provider = new AwsKmsProvider(kms, 'alias/wea');

    await provider.unwrapDataKey(Buffer.from('blob'), 7);

    expect(kms.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({ KeyId: 'alias/wea' }) as never,
    );
  });

  it('refuses a response with no plaintext', async () => {
    const kms = fakeKms({ decrypt: vi.fn(async () => ({})) });

    await expect(new AwsKmsProvider(kms, 'k').unwrapDataKey(Buffer.from('b'), 1)).rejects.toThrow(
      /no key material/,
    );
  });
});

describe('which failures are worth retrying', () => {
  it.each(['ThrottlingException', 'KMSInternalException', 'KeyUnavailableException'])(
    'retries %s',
    async (name) => {
      const kms = fakeKms({
        generateDataKey: vi.fn(async () => {
          throw kmsError(name);
        }),
      });

      await expect(new AwsKmsProvider(kms, 'k').generateDataKey()).rejects.toMatchObject({
        retryable: true,
      });
    },
  );

  it.each([
    'AccessDeniedException',
    'DisabledException',
    'NotFoundException',
    'InvalidCiphertextException',
  ])('does not retry %s', async (name) => {
    // These fail identically on the second attempt. Retrying only delays the
    // alert and burns the request budget.
    const kms = fakeKms({
      decrypt: vi.fn(async () => {
        throw kmsError(name);
      }),
    });

    await expect(
      new AwsKmsProvider(kms, 'k').unwrapDataKey(Buffer.from('b'), 1),
    ).rejects.toMatchObject({ retryable: false });
  });

  it('names the operation and the AWS error in the message', async () => {
    const kms = fakeKms({
      generateDataKey: vi.fn(async () => {
        throw kmsError('AccessDeniedException');
      }),
    });

    await expect(new AwsKmsProvider(kms, 'k').generateDataKey()).rejects.toThrow(
      /GenerateDataKey.*AccessDeniedException/,
    );
  });

  it('survives a thrown value that is not an Error', async () => {
    const kms = fakeKms({
      generateDataKey: vi.fn(async () => {
        throw 'a string, because SDKs do that';
      }),
    });

    await expect(new AwsKmsProvider(kms, 'k').generateDataKey()).rejects.toMatchObject({
      code: 'ENCRYPTION_FAILURE',
    });
  });
});

describe('configuration', () => {
  it('refuses to construct without a key id', () => {
    expect(() => new AwsKmsProvider(fakeKms(), '')).toThrow(/KMS_KEY_ID/);
  });

  it('reports itself as aws', () => {
    expect(new AwsKmsProvider(fakeKms(), 'k').name).toBe('aws');
  });
});

describe('through the envelope layer', () => {
  it('round-trips a payload, AAD and all', async () => {
    // The point of the adapter is that everything above it is unchanged. A fake
    // KMS that wraps by prefixing is enough to prove the seam: the envelope
    // layer hands over a plaintext key, gets a blob back, and later gets the
    // same key from the blob.
    const store = new Map<string, Buffer>();
    let n = 0;

    const kms: KmsCryptoApi = {
      generateDataKey: async () => {
        const plaintext = Buffer.alloc(32, (n % 250) + 1);
        const blob = Buffer.from(`blob-${n++}`);
        store.set(blob.toString(), plaintext);
        return { Plaintext: new Uint8Array(plaintext), CiphertextBlob: new Uint8Array(blob) };
      },
      decrypt: async ({ CiphertextBlob }) => {
        const key = store.get(Buffer.from(CiphertextBlob).toString());
        if (!key) throw kmsError('InvalidCiphertextException');
        return { Plaintext: new Uint8Array(key) };
      },
    };

    const crypto = new EnvelopeEncryption(new AwsKmsProvider(kms, 'alias/wea'));
    const context = { userId: 'user-1', field: 'refreshToken' };

    const sealed = await crypto.encryptString('ya29.a-real-looking-token', context);
    expect(await crypto.decryptString(sealed, context)).toBe('ya29.a-real-looking-token');

    // And the AAD binding still holds on top of a KMS-wrapped key: the same
    // ciphertext read as another user's row must fail.
    await expect(
      crypto.decryptString(sealed, { userId: 'user-2', field: 'refreshToken' }),
    ).rejects.toThrow();
  });
});
