import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every setting is read by something, or is listed here as knowingly not.
 *
 * Five settings were found by accident over the course of one week, each the
 * same way: someone went looking for the code behind a claim and there was
 * none. `KMS_PROVIDER` meant production either failed to boot or ran on a
 * static key while the operator believed the KEK was in a managed service. The
 * three `RATE_LIMIT_*` values meant `/v1/auth/signin` was an oracle anyone
 * could query at line rate. `SESSION_COOKIE_NAME` sat over a refresh flow that
 * answered 400 to every request the dashboard made.
 *
 * A sweep then found eighteen more. The pattern is not carelessness about any
 * one setting — it is that nothing ever asked the question, so this file asks
 * it. A new setting with no reader fails here, and adding it to the list below
 * is a deliberate act with a reason attached.
 *
 * What this cannot check is whether a reader does the *right* thing with the
 * value. `TOTP_ISSUER` would have passed a test like this if the code had read
 * it and thrown it away. That is what the other tests are for.
 */

const ROOT = new URL('../../../', import.meta.url).pathname;

/** Where product code lives. Tests and build output are not readers. */
const SOURCE_DIRS = [
  'apps/api/src',
  'apps/worker/src',
  'apps/web/src',
  'packages/shared/src',
  'packages/crypto/src',
  'packages/db/src',
  'packages/mail/src',
  'packages/whatsapp/src',
  'packages/ai/src',
];

/**
 * Settings deliberately read by nothing, each with the reason.
 *
 * Every entry here is a promise the config makes that the code does not keep,
 * so the list is meant to shrink. It is not a place to put a setting you have
 * not thought about.
 */
const KNOWINGLY_UNREAD: Record<string, string> = {
  // Billing is not built and there is no Stripe code anywhere.
  STRIPE_SECRET_KEY: 'billing not built',
  STRIPE_WEBHOOK_SECRET: 'billing not built',
  STRIPE_PRICE_STARTER: 'billing not built',
  STRIPE_PRICE_PRO: 'billing not built',
  STRIPE_PRICE_BUSINESS: 'billing not built',

  // Attachment bytes are streamed provider↔Meta and never stored; nothing
  // imports an S3 client. Reserved for attachment scanning and OCR, which the
  // schema is shaped for (`extracted_text`, `scanned_at`) and which do not
  // exist. All optional, so nobody provisions a bucket for them.
  S3_ENDPOINT: 'no object storage in the path',
  S3_REGION: 'no object storage in the path',
  S3_BUCKET: 'no object storage in the path',
  S3_ACCESS_KEY_ID: 'no object storage in the path',
  S3_SECRET_ACCESS_KEY: 'no object storage in the path',
  S3_FORCE_PATH_STYLE: 'no object storage in the path',
  RETENTION_ATTACHMENT_DAYS: 'nothing to expire while nothing is stored',

  // Tracing and error reporting are not wired. The Jaeger container in
  // docker-compose sits behind an `observability` profile, so it does not run
  // by default and does not imply otherwise.
  OTEL_ENABLED: 'tracing not wired',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'tracing not wired',
  SENTRY_DSN: 'error reporting not wired',

  // `/metrics` is always served. A flag that turned it off would mean an
  // operator could silence the alerting without the alerting noticing.
  METRICS_ENABLED: 'metrics are unconditional by design',

  // Signs nothing: refresh tokens are random strings stored as a hash, not
  // JWTs, which is what makes rotation and revocation possible. Optional now,
  // so it no longer implies a signature that does not exist.
  JWT_REFRESH_SECRET: 'refresh tokens are not JWTs',

  // The application role cannot delete audit rows — that is the point of an
  // append-only trail — so expiring them is an operator job. See the runbook.
  RETENTION_AUDIT_DAYS: 'enforced by an operator, not by the app',

  // Transcription runs through the configured AI provider's capability rather
  // than a separate service. These name services that do not exist here.
  SPEECH_TO_TEXT_PROVIDER: 'transcription goes through the AI provider capability',
  TEXT_TO_SPEECH_PROVIDER: 'reading a message aloud is not built',
  OCR_PROVIDER: 'attachment text extraction is not built',

  // Per-user budgets are enforced; per-org is not, because organisations have
  // no billing to enforce against yet.
  AI_MAX_TOKENS_PER_ORG_DAY: 'org budgets not enforced while billing is unbuilt',

  // Pub/Sub push is configured by topic name; the project is implied by it.
  GOOGLE_PROJECT_ID: 'implied by GOOGLE_PUBSUB_TOPIC',

  // Prisma takes its pool size from the connection string.
  DATABASE_POOL_SIZE: 'Prisma reads this from DATABASE_URL',
};

function sourceFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const found: string[] = [];

  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        found.push(full);
      }
    }
  };

  try {
    walk(absolute);
  } catch {
    // A package without a src directory is not a failure of this test.
  }

  return found;
}

describe('every setting has a reader', () => {
  const schemaPath = join(ROOT, 'packages/shared/src/config/env.schema.ts');
  const schema = readFileSync(schemaPath, 'utf8');
  const declared = [
    ...new Set([...schema.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!)),
  ];

  // Everything except the schema file, which declares them rather than reads them.
  const corpus = SOURCE_DIRS.flatMap(sourceFiles)
    .filter((file) => file !== schemaPath)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');

  it('finds a plausible number of settings, so a broken regex fails loudly', () => {
    // Without this, a change to the schema's formatting would make `declared`
    // empty and every assertion below pass vacuously.
    expect(declared.length).toBeGreaterThan(60);
  });

  it.each(declared.filter((name) => !(name in KNOWINGLY_UNREAD)))(
    '%s is read somewhere',
    (name) => {
      expect(corpus).toContain(name);
    },
  );

  it('does not excuse a setting that is actually read', () => {
    // The list is meant to shrink. An entry that has quietly gained a reader
    // should come off it, or the next person reads the reason and believes it.
    const stale = Object.keys(KNOWINGLY_UNREAD).filter((name) => corpus.includes(name));

    expect(stale).toEqual([]);
  });

  it('gives a reason for every exception', () => {
    for (const [name, reason] of Object.entries(KNOWINGLY_UNREAD)) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10);
    }
  });
});
