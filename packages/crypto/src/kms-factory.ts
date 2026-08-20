import { AppError } from '@wea/shared';
import { LocalKmsProvider, CachingKmsProvider, type KmsProvider } from './kms.js';
import { AwsKmsProvider, awsKmsClient } from './kms-aws.js';

/**
 * The one place the KEK provider is chosen.
 *
 * It did not exist, and its absence was not a tidiness problem. Four call sites
 * — three in the API, one in the worker — each wrote
 * `LocalKmsProvider.fromBase64(env.ENCRYPTION_MASTER_KEY ?? '')` directly, so
 * `KMS_PROVIDER` was read by nothing at all. ADR 0002 says the key-encryption
 * key lives in a KMS and that the local key "stands in for KMS behind the same
 * interface"; the interface was there and the KMS behind it was not.
 *
 * That produced two failures, and the quiet one is the worse:
 *
 *  - With `KMS_PROVIDER=aws` and no `ENCRYPTION_MASTER_KEY` — the only shape the
 *    environment schema permits in production — every one of those four
 *    constructors threw at boot. Production was unreachable by construction.
 *  - With `KMS_PROVIDER=aws` **and** a master key set, which is what copying
 *    `.env.example` gives you, it started and used the static key from the
 *    process environment while the operator believed the KEK was in a managed
 *    service. A claim about where key material lives, silently untrue.
 *
 * So the choice is made here, once, and an unimplemented provider refuses to
 * start rather than falling back. Falling back to a local key would be the same
 * bug with a friendlier face.
 */

/** What the factory needs. A subset of `Env`, so this package stays independent of it. */
export interface KmsSelection {
  KMS_PROVIDER: 'local' | 'aws' | 'azure' | 'gcp';
  KMS_KEY_ID?: string | undefined;
  ENCRYPTION_MASTER_KEY?: string | undefined;
}

/** Providers named by the environment schema that nothing implements yet. */
export const UNIMPLEMENTED_KMS_PROVIDERS = ['azure', 'gcp'] as const;

/**
 * Builds the provider named by the environment.
 *
 * Wrapped in {@link CachingKmsProvider} by every caller previously, and here
 * instead — the cache is not a caller's decision, it is what stops one KMS call
 * per decrypt (ADR 0002).
 *
 * @throws when the environment names a provider that does not exist, or a local
 *   provider with no usable key. Both at boot, never at first decrypt.
 */
export function createKmsProvider(env: KmsSelection): KmsProvider {
  if (env.KMS_PROVIDER === 'local') {
    if (!env.ENCRYPTION_MASTER_KEY) {
      throw new AppError(
        'ENCRYPTION_FAILURE',
        'KMS_PROVIDER=local needs ENCRYPTION_MASTER_KEY (openssl rand -base64 32)',
        { retryable: false },
      );
    }
    return new CachingKmsProvider(LocalKmsProvider.fromBase64(env.ENCRYPTION_MASTER_KEY));
  }

  if (env.KMS_PROVIDER === 'aws') {
    if (!env.KMS_KEY_ID) {
      throw new AppError(
        'ENCRYPTION_FAILURE',
        'KMS_PROVIDER=aws needs KMS_KEY_ID (a key id, alias/name or ARN)',
        { retryable: false },
      );
    }
    return new CachingKmsProvider(new AwsKmsProvider(awsKmsClient(), env.KMS_KEY_ID));
  }

  // Deliberately a refusal rather than a fallback. The environment schema
  // already forbids `local` in production, so reaching this line means the
  // operator asked for managed key material and there is none to give them —
  // and quietly handing back a static key from the process environment is
  // exactly the outcome ADR 0002 exists to prevent.
  throw new AppError(
    'ENCRYPTION_FAILURE',
    `KMS_PROVIDER=${env.KMS_PROVIDER} is not implemented — "local" and "aws" are. ` +
      'ADR 0002 specifies a managed KEK and the adapter for it has not been written, ' +
      'so there is no configuration in which this process both starts and keeps the ' +
      'key-encryption key outside its own environment. See docs/status.md.',
    { retryable: false },
  );
}
