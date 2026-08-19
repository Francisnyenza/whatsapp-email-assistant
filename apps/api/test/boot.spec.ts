import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'reflect-metadata';
import { existsSync } from 'node:fs';

/**
 * Can the application actually start.
 *
 * This test exists because the answer was **no**, and had been for the whole
 * life of the project, while every other test passed.
 *
 * `ConfigService` took `constructor(source: NodeJS.ProcessEnv = process.env)`.
 * `emitDecoratorMetadata` records that parameter's type as `Object`; a default
 * value is not part of the metadata, and injection always supplies its own
 * argument. So Nest looked for a provider of type `Object`, found none, and
 * refused to construct the one class every other class depends on.
 *
 * Nothing caught it. The unit tests build services with `new Service(deps)` and
 * never ask the container to do it; `di.spec.ts` counts constructor parameters
 * through reflection, which is a different question from whether they resolve.
 * And it failed *silently*: Nest handles a start-up error inside its own
 * exception zone and calls `process.exit(1)` there, before `bootstrap().catch`
 * runs, with the reason routed to a logger `main.ts` had disabled. The
 * observable behaviour was a process that exited 1 having printed nothing.
 *
 * So this asks the container the real question: resolve the whole graph. It
 * stops short of `listen`, so no lifecycle hook runs and neither Postgres nor
 * Redis is needed to answer it.
 *
 * Against `dist/` for the reason `di.spec.ts` gives — vitest transpiles with
 * esbuild, which does not implement `emitDecoratorMetadata`, so under esbuild
 * *every* injected parameter is undefined and the test would fail for a reason
 * that has nothing to do with the code. Only the tsc output carries the
 * metadata, and the tsc output is what runs in production.
 */

const DIST = new URL('../dist/', import.meta.url);
const built = existsSync(new URL('app.module.js', DIST));

/** A complete, syntactically valid environment. None of it needs to be real. */
const FAKE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  API_BASE_URL: 'https://api.test.invalid',
  WEB_BASE_URL: 'https://app.test.invalid',
  DATABASE_URL: 'postgresql://wea:wea@localhost:5432/wea',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'wea-attachments',
  // 32 and 64 bytes respectively, base64 — the schema checks the decoded length.
  ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  BLIND_INDEX_KEY: Buffer.alloc(32, 9).toString('base64'),
  JWT_ACCESS_SECRET: Buffer.alloc(64, 1).toString('base64'),
  JWT_REFRESH_SECRET: Buffer.alloc(64, 2).toString('base64'),
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_ACCESS_TOKEN: 'test-token',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  AI_PRIMARY_PROVIDER: 'none',
};

interface Container {
  get: (token: unknown) => unknown;
  close: () => Promise<void>;
}

async function createApp(): Promise<Container> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = (await import(new URL('app.module.js', DIST).href)) as {
    AppModule: unknown;
  };

  // `abortOnError: false` is what makes a failure observable here. Left at its
  // default, Nest exits the whole test process on a resolution error and the
  // run reports nothing useful — which is exactly how the bug survived.
  return (await NestFactory.create(AppModule as never, {
    abortOnError: false,
    logger: false,
    bodyParser: false,
  })) as unknown as Container;
}

describe.skipIf(!built)('the application starts (compiled output)', () => {
  let app: Container;
  let saved: NodeJS.ProcessEnv;

  beforeAll(async () => {
    saved = { ...process.env };
    Object.assign(process.env, FAKE_ENV);
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
    process.env = saved;
  });

  it('resolves every provider and controller through the container', () => {
    // Reaching this line at all is the assertion — the `create` above throws on
    // any unresolvable dependency anywhere in the graph.
    expect(app).toBeDefined();
  });

  it('can build the ConfigService the whole graph depends on', async () => {
    // The class that could not be constructed. Asking the *container* for it,
    // rather than calling `new ConfigService()`, is the entire point: the
    // constructor always worked when called directly, which is why every unit
    // test passed.
    const { ConfigService } = (await import(new URL('config/config.service.js', DIST).href)) as {
      ConfigService: unknown;
    };
    const config = app.get(ConfigService) as { env: Record<string, string> };

    expect(config.env['NODE_ENV']).toBe('test');
    expect(config.env['WHATSAPP_PHONE_NUMBER_ID']).toBe('1234567890');
  });

  it('wires the logger the config module provides', () => {
    expect(app.get('LOGGER')).toHaveProperty('info');
  });

  it('mounts the health and metrics controllers', async () => {
    // Controllers resolve through the same machinery and break the same way.
    const { HealthController } = (await import(
      new URL('health/health.controller.js', DIST).href
    )) as {
      HealthController: new (...args: never[]) => unknown;
    };
    const { MetricsController } = (await import(
      new URL('health/metrics.controller.js', DIST).href
    )) as { MetricsController: new (...args: never[]) => unknown };

    expect(app.get(HealthController)).toBeInstanceOf(HealthController);
    expect(app.get(MetricsController)).toBeInstanceOf(MetricsController);
  });
});

describe.skipIf(!built)('a bad environment', () => {
  it('refuses to start, and names what is missing', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, FAKE_ENV);
    delete process.env['WHATSAPP_ACCESS_TOKEN'];

    try {
      await expect(createApp()).rejects.toThrow(/WHATSAPP_ACCESS_TOKEN/);
    } finally {
      process.env = saved;
    }
  });
});
