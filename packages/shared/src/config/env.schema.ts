import { z } from 'zod';

/**
 * The environment contract, validated once at boot.
 *
 * A process that starts with a missing secret and fails three hours later under
 * load is far worse than one that refuses to start. Every service calls
 * `loadEnv()` before anything else; a failure prints every offending variable at
 * once rather than one per restart.
 */

const nonEmpty = (label: string) => z.string().min(1, `${label} must not be empty`);

/** Accepts "true"/"1"/"yes" case-insensitively; anything else is false. */
const booleanish = z
  .string()
  .optional()
  .transform((v) => /^(true|1|yes)$/i.test(v ?? ''));

const intFrom = (fallback: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min));

/** A base64-encoded 256-bit key. */
const base64Key32 = z.string().refine(
  (v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be a base64-encoded 32-byte key (openssl rand -base64 32)' },
);

export const envSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    API_PORT: intFrom(3001, 1),
    WORKER_PORT: intFrom(3002, 1),
    API_BASE_URL: z.string().url(),
    WEB_BASE_URL: z.string().url(),

    // Datastores
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_SIZE: intFrom(20, 1),
    REDIS_URL: z.string().url(),
    REDIS_QUEUE_URL: z.string().url().optional(),

    // Object storage
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: nonEmpty('S3_BUCKET'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanish,

    // Cryptography — see ADR 0002
    ENCRYPTION_MASTER_KEY: base64Key32.optional(),
    KMS_PROVIDER: z.enum(['local', 'aws', 'azure', 'gcp']).default('local'),
    KMS_KEY_ID: z.string().optional(),
    BLIND_INDEX_KEY: base64Key32,

    // Auth
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),
    SESSION_COOKIE_NAME: z.string().default('wea_session'),
    TOTP_ISSUER: z.string().default('Inbox on WhatsApp'),

    // WhatsApp Cloud API
    WHATSAPP_PHONE_NUMBER_ID: nonEmpty('WHATSAPP_PHONE_NUMBER_ID'),
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: nonEmpty('WHATSAPP_ACCESS_TOKEN'),
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: nonEmpty('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    WHATSAPP_APP_SECRET: nonEmpty('WHATSAPP_APP_SECRET'),

    // Google / Gmail
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    GOOGLE_PUBSUB_TOPIC: z.string().optional(),
    GOOGLE_PUBSUB_VERIFICATION_AUDIENCE: z.string().optional(),
    GOOGLE_PROJECT_ID: z.string().optional(),

    // Microsoft / Outlook
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().default('common'),
    MICROSOFT_REDIRECT_URI: z.string().url().optional(),
    MICROSOFT_WEBHOOK_CLIENT_STATE: z.string().optional(),
    MICROSOFT_NOTIFICATION_URL: z.string().url().optional(),

    // AI
    AI_PRIMARY_PROVIDER: z.enum(['openai', 'gemini', 'anthropic']).default('openai'),
    AI_FALLBACK_PROVIDER: z.enum(['openai', 'gemini', 'anthropic', 'none']).default('none'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL_FAST: z.string().default('gpt-4o-mini'),
    OPENAI_MODEL_SMART: z.string().default('gpt-4o'),
    OPENAI_MODEL_EMBEDDING: z.string().default('text-embedding-3-small'),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL_FAST: z.string().default('gemini-2.0-flash'),
    GEMINI_MODEL_SMART: z.string().default('gemini-2.0-pro'),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
    ANTHROPIC_MODEL_SMART: z.string().default('claude-sonnet-5'),
    AI_MAX_TOKENS_PER_USER_DAY: intFrom(200_000, 0),
    AI_MAX_TOKENS_PER_ORG_DAY: intFrom(5_000_000, 0),
    AI_REQUEST_TIMEOUT_MS: intFrom(20_000, 1000),

    // Speech & OCR
    SPEECH_TO_TEXT_PROVIDER: z.enum(['openai', 'google', 'azure']).default('openai'),
    TEXT_TO_SPEECH_PROVIDER: z.enum(['openai', 'google', 'azure']).default('openai'),
    OCR_PROVIDER: z.enum(['tesseract', 'google-vision', 'azure-vision']).default('tesseract'),

    // Billing
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // Rate limits
    RATE_LIMIT_GLOBAL_PER_MIN: intFrom(600, 1),
    RATE_LIMIT_AUTH_PER_MIN: intFrom(10, 1),
    RATE_LIMIT_WEBHOOK_PER_MIN: intFrom(6000, 1),

    // Retention
    RETENTION_BODY_DAYS: intFrom(30, 1),
    RETENTION_ATTACHMENT_DAYS: intFrom(30, 1),
    RETENTION_AUDIT_DAYS: intFrom(365, 1),

    // Observability
    OTEL_ENABLED: booleanish,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
    OTEL_SERVICE_NAME: z.string().default('wea-api'),
    SENTRY_DSN: z.string().optional(),
    METRICS_ENABLED: booleanish,

    // Feature flags
    FEATURE_VOICE_NOTES: booleanish,
    FEATURE_SEMANTIC_SEARCH: booleanish,
    FEATURE_AUTOMATIONS: booleanish,
    FEATURE_IMAP: booleanish,
  })
  .superRefine((env, ctx) => {
    // A static master key in the process environment is fine for local work and
    // unacceptable in production, where the KEK must live in a KMS (ADR 0002).
    if (env.NODE_ENV === 'production') {
      if (env.KMS_PROVIDER === 'local') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['KMS_PROVIDER'],
          message: 'KMS_PROVIDER must not be "local" in production — use aws, azure or gcp',
        });
      }
      if (!env.KMS_KEY_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['KMS_KEY_ID'],
          message: 'KMS_KEY_ID is required in production',
        });
      }
    } else if (env.KMS_PROVIDER === 'local' && !env.ENCRYPTION_MASTER_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENCRYPTION_MASTER_KEY'],
        message: 'ENCRYPTION_MASTER_KEY is required when KMS_PROVIDER=local',
      });
    }

    // A configured AI provider without its key is a runtime failure disguised as
    // a config value; catch it at boot.
    const aiKeys: Record<string, string | undefined> = {
      openai: env.OPENAI_API_KEY,
      gemini: env.GEMINI_API_KEY,
      anthropic: env.ANTHROPIC_API_KEY,
    };
    for (const provider of [env.AI_PRIMARY_PROVIDER, env.AI_FALLBACK_PROVIDER]) {
      if (provider !== 'none' && !aiKeys[provider]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`${provider.toUpperCase()}_API_KEY`],
          message: `required because it is selected as an AI provider`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates `source` (defaults to `process.env`).
 *
 * @throws {Error} listing every invalid variable, with values omitted — a
 *   validation error must never echo a secret into logs.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${problems}`);
}
