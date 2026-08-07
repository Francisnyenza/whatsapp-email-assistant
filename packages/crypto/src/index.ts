/** Public surface of @wea/crypto. */

export { LocalKmsProvider, CachingKmsProvider, type KmsProvider, type DataKey } from './kms.js';

export { EnvelopeEncryption, type EncryptedPayload, type EncryptionContext } from './envelope.js';

export { BlindIndex } from './blind-index.js';

export {
  hashPassword,
  verifyPassword,
  needsRehash,
  generateToken,
  hashToken,
  verifyToken,
  generateRecoveryCodes,
  matchRecoveryCode,
  type GeneratedToken,
} from './passwords.js';

export {
  safeCompare,
  verifyMetaSignature,
  verifyStripeSignature,
  verifyGraphClientState,
  signPayload,
  verifyPayloadSignature,
} from './signatures.js';

export {
  generateTotpSecret,
  totpCode,
  stepFor,
  verifyTotp,
  otpauthUri,
  base32Encode,
  base32Decode,
  TOTP_STEP_SECONDS,
  TOTP_WINDOW,
  type TotpVerification,
} from './totp.js';
