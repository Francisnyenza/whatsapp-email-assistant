import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../src/config/env.schema.js';

const key32 = () => randomBytes(32).toString('base64');

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'development',
    API_BASE_URL: 'http://localhost:3001',
    WEB_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://wea:pw@localhost:5432/wea',
    REDIS_URL: 'redis://localhost:6379',
    S3_BUCKET: 'wea-attachments',
    ENCRYPTION_MASTER_KEY: key32(),
    BLIND_INDEX_KEY: key32(),
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    WHATSAPP_PHONE_NUMBER_ID: '123456',
    WHATSAPP_ACCESS_TOKEN: 'token',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify',
    WHATSAPP_APP_SECRET: 'app-secret',
    AI_PRIMARY_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('environment validation', () => {
  it('accepts a complete development environment and applies defaults', () => {
    const env = loadEnv(baseEnv());
    expect(env.API_PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.WHATSAPP_API_VERSION).toBe('v21.0');
    expect(env.RETENTION_BODY_DAYS).toBe(30);
  });

  it('reports every problem at once rather than one per restart', () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    delete env.WHATSAPP_APP_SECRET;

    try {
      loadEnv(env);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('WHATSAPP_APP_SECRET');
    }
  });

  it('never echoes a secret value in a validation error', () => {
    const env = baseEnv({ JWT_ACCESS_SECRET: 'too-short', ENCRYPTION_MASTER_KEY: 'not-base64' });
    try {
      loadEnv(env);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).not.toContain('too-short');
      expect(message).not.toContain('not-base64');
    }
  });

  it('rejects a webhook secret that is missing', () => {
    const env = baseEnv();
    delete env.WHATSAPP_APP_SECRET;
    expect(() => loadEnv(env)).toThrow(/WHATSAPP_APP_SECRET/);
  });

  it('requires a key for whichever AI provider is selected', () => {
    expect(() => loadEnv(baseEnv({ AI_PRIMARY_PROVIDER: 'gemini' }))).toThrow(/GEMINI_API_KEY/);
    expect(() =>
      loadEnv(baseEnv({ AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-key' })),
    ).not.toThrow();
  });

  it('refuses a static encryption key in production (ADR 0002)', () => {
    const env = baseEnv({ NODE_ENV: 'production', KMS_PROVIDER: 'local' });
    expect(() => loadEnv(env)).toThrow(/KMS_PROVIDER/);
  });

  it('requires a KMS key id in production', () => {
    const env = baseEnv({ NODE_ENV: 'production', KMS_PROVIDER: 'aws' });
    expect(() => loadEnv(env)).toThrow(/KMS_KEY_ID/);

    expect(() =>
      loadEnv(
        baseEnv({ NODE_ENV: 'production', KMS_PROVIDER: 'aws', KMS_KEY_ID: 'arn:aws:kms:…' }),
      ),
    ).not.toThrow();
  });

  it('requires a local master key when no KMS is configured', () => {
    const env = baseEnv();
    delete env.ENCRYPTION_MASTER_KEY;
    expect(() => loadEnv(env)).toThrow(/ENCRYPTION_MASTER_KEY/);
  });

  it('coerces boolean-ish flags', () => {
    expect(loadEnv(baseEnv({ OTEL_ENABLED: 'true' })).OTEL_ENABLED).toBe(true);
    expect(loadEnv(baseEnv({ OTEL_ENABLED: 'YES' })).OTEL_ENABLED).toBe(true);
    expect(loadEnv(baseEnv({ OTEL_ENABLED: 'false' })).OTEL_ENABLED).toBe(false);
    expect(loadEnv(baseEnv()).OTEL_ENABLED).toBe(false);
  });
});
