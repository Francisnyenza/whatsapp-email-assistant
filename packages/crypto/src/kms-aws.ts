import { createRequire } from 'node:module';
import { AppError } from '@wea/shared';
import type { DataKey, KmsProvider } from './kms.js';

/**
 * AWS KMS as the key-encryption key.
 *
 * ADR 0002 has specified this since the first phase and nothing implemented it,
 * so `KMS_PROVIDER=aws` either failed to boot or — worse — quietly ran on a
 * static key from the process environment. This is the adapter that makes the
 * setting mean what it says.
 *
 * The KEK never leaves KMS. `GenerateDataKey` returns a fresh 256-bit key twice:
 * once in plaintext for immediate use, once wrapped under the CMK, and only the
 * wrapped copy is persisted. `Decrypt` unwraps it again. Everything above this
 * class deals only in wrapped keys.
 *
 * **No encryption context here, deliberately.** ADR 0002's binding promise —
 * that a stolen ciphertext cannot be pasted into another user's row — is kept by
 * the envelope layer, which authenticates every payload against `userId:field`
 * as AES-GCM additional data. Adding a second, coarser binding at this level
 * would suggest a per-record guarantee that this class is not the one making.
 *
 * The interface's `keyVersion` is nominal for AWS. A KMS ciphertext blob names
 * the key material that produced it, so rotation is KMS's business and unwrapping
 * needs no version from us — where the local provider genuinely keeps a
 * generation map, this reports a constant and ignores what it is handed.
 */

/**
 * The two calls this needs, and nothing else.
 *
 * A port rather than the SDK client, so the adapter's behaviour — how it maps a
 * throttle to a retryable failure, what it does with a response missing its
 * plaintext — is testable without AWS credentials or a network. The real client
 * is wired in {@link awsKmsClient}, which is the only code here that imports the
 * SDK.
 */
export interface KmsCryptoApi {
  generateDataKey(input: {
    KeyId: string;
    KeySpec: 'AES_256';
  }): Promise<{ Plaintext?: Uint8Array | undefined; CiphertextBlob?: Uint8Array | undefined }>;
  decrypt(input: {
    CiphertextBlob: Uint8Array;
    KeyId?: string | undefined;
  }): Promise<{ Plaintext?: Uint8Array | undefined }>;
}

/** AES-256, so the data key matches what the envelope layer expects. */
const DEK_BYTES = 32;

/**
 * The single version this provider reports.
 *
 * Not a placeholder for future rotation — see the class comment. KMS rotates the
 * CMK's backing material on its own schedule and every ciphertext blob still
 * decrypts, so there is no generation for this layer to track.
 */
export const AWS_KEY_VERSION = 1;

/**
 * KMS failures worth retrying.
 *
 * Throttling and the service's own internal errors are transient; everything
 * else — a denied grant, a disabled key, a ciphertext from another CMK — will
 * fail again identically, and retrying only delays the alert.
 */
const RETRYABLE = new Set([
  'ThrottlingException',
  'KMSInternalException',
  'KeyUnavailableException',
  'DependencyTimeoutException',
  'LimitExceededException',
]);

/** The SDK reports its error kind in `name`; be tolerant of shapes without one. */
function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

function wrap(err: unknown, operation: string): AppError {
  const name = errorName(err);
  const message = err instanceof Error ? err.message : String(err);

  return new AppError('ENCRYPTION_FAILURE', `AWS KMS ${operation} failed: ${name || message}`, {
    retryable: RETRYABLE.has(name),
    cause: err,
  });
}

export class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws';
  readonly currentKeyVersion = AWS_KEY_VERSION;

  constructor(
    private readonly kms: KmsCryptoApi,
    /** The CMK: a key id, alias (`alias/wea`) or full ARN. */
    private readonly keyId: string,
  ) {
    if (!keyId) {
      throw new AppError('ENCRYPTION_FAILURE', 'KMS_KEY_ID is required for KMS_PROVIDER=aws', {
        retryable: false,
      });
    }
  }

  async generateDataKey(): Promise<DataKey> {
    let response: Awaited<ReturnType<KmsCryptoApi['generateDataKey']>>;
    try {
      response = await this.kms.generateDataKey({ KeyId: this.keyId, KeySpec: 'AES_256' });
    } catch (err) {
      throw wrap(err, 'GenerateDataKey');
    }

    // A 200 missing either half is not something to paper over: continuing with
    // an empty buffer would encrypt real mail under a key of zero bytes.
    if (!response.Plaintext || !response.CiphertextBlob) {
      throw new AppError('ENCRYPTION_FAILURE', 'AWS KMS GenerateDataKey returned no key material', {
        retryable: false,
      });
    }

    const plaintext = Buffer.from(response.Plaintext);
    if (plaintext.length !== DEK_BYTES) {
      throw new AppError(
        'ENCRYPTION_FAILURE',
        `AWS KMS returned a ${plaintext.length}-byte data key; AES-256 needs ${DEK_BYTES}`,
        { retryable: false },
      );
    }

    return {
      plaintext,
      wrapped: Buffer.from(response.CiphertextBlob),
      keyVersion: AWS_KEY_VERSION,
    };
  }

  /**
   * `keyVersion` is accepted and ignored — the blob carries what KMS needs.
   *
   * Ignoring it is what lets a record written under one CMK rotation decrypt
   * after the next one, which is the property the local provider has to keep a
   * map for.
   */
  async unwrapDataKey(wrapped: Buffer, _keyVersion: number): Promise<Buffer> {
    let response: Awaited<ReturnType<KmsCryptoApi['decrypt']>>;
    try {
      // `KeyId` is passed even though the blob names its own key: it turns a
      // ciphertext from some *other* CMK into a rejection rather than a
      // successful decrypt, which is the difference between an attacker
      // supplying their own wrapped key and not.
      response = await this.kms.decrypt({ CiphertextBlob: wrapped, KeyId: this.keyId });
    } catch (err) {
      throw wrap(err, 'Decrypt');
    }

    if (!response.Plaintext) {
      throw new AppError('ENCRYPTION_FAILURE', 'AWS KMS Decrypt returned no key material', {
        retryable: false,
      });
    }

    return Buffer.from(response.Plaintext);
  }
}

/**
 * The real client, wired to the port.
 *
 * Resolved through `createRequire` rather than a static import so a deployment
 * running `KMS_PROVIDER=local` never loads the SDK — it is by far the heaviest
 * dependency in this package and most installations will not use it. Synchronous
 * because the callers are constructors, which cannot await.
 *
 * Credentials and region come from the standard AWS chain: on EKS that is the
 * pod's IAM role via IRSA, which is what the Terraform module provisions and the
 * reason none of it is configured here.
 */
export function awsKmsClient(): KmsCryptoApi {
  const require = createRequire(import.meta.url);

  let sdk: {
    KMSClient: new (config: Record<string, unknown>) => {
      send: (command: unknown) => Promise<unknown>;
    };
    GenerateDataKeyCommand: new (input: unknown) => unknown;
    DecryptCommand: new (input: unknown) => unknown;
  };

  try {
    sdk = require('@aws-sdk/client-kms');
  } catch (err) {
    // A clear boot failure beats a stack trace from a module loader. The
    // dependency is declared, so reaching this means a pruned or partial
    // install rather than a missing entry in package.json.
    throw new AppError(
      'ENCRYPTION_FAILURE',
      'KMS_PROVIDER=aws needs @aws-sdk/client-kms, which is not installed',
      { retryable: false, cause: err },
    );
  }

  const client = new sdk.KMSClient({});

  return {
    generateDataKey: (input) =>
      client.send(new sdk.GenerateDataKeyCommand(input)) as ReturnType<
        KmsCryptoApi['generateDataKey']
      >,
    decrypt: (input) =>
      client.send(new sdk.DecryptCommand(input)) as ReturnType<KmsCryptoApi['decrypt']>,
  };
}
