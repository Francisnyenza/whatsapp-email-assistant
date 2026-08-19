import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'reflect-metadata';
import { existsSync } from 'node:fs';

/**
 * Can the worker actually start.
 *
 * The companion to the API's `boot.spec.ts`, and it exists for the same reason:
 * this worker's `ConfigService` carried the identical
 * `constructor(source: NodeJS.ProcessEnv = process.env)` that made the API
 * unstartable. `emitDecoratorMetadata` records that parameter as type `Object`,
 * a default value is not part of the metadata, and injection always supplies
 * its own argument — so Nest looked for a provider of type `Object`, found
 * none, and would not build the class every processor depends on.
 *
 * It failed silently in the same way too. Nest handles a start-up error inside
 * its own exception zone and calls `process.exit(1)` from there, before
 * `bootstrap().catch` runs, and `main.ts` had disabled the logger that would
 * have said why. A worker that dies at boot printing nothing looks, from
 * outside, exactly like a worker with no work to do.
 *
 * `createApplicationContext` resolves the whole graph without running a
 * lifecycle hook, so the queue consumers are never started and no Redis or
 * Postgres connection is opened. Against `dist/` because vitest transpiles with
 * esbuild, which does not implement `emitDecoratorMetadata` — see
 * `di.spec.ts`.
 */

const DIST = new URL('../dist/', import.meta.url);
const built = existsSync(new URL('worker.module.js', DIST));

/**
 * An integration test, unlike the API's.
 *
 * `createApplicationContext` runs the lifecycle hooks, so `PrismaService`
 * connects and the queue consumers attach to Redis. `NestFactory.create` — what
 * the API's equivalent uses — stops before `init`, which is why that one needs
 * nothing running.
 *
 * Both services are therefore required, and the whole file skips without them
 * rather than failing on a machine that simply has not started Docker.
 */
const database = process.env['DATABASE_URL'];
const runnable = built && Boolean(database);

/** A complete, syntactically valid environment. None of it needs to be real. */
const FAKE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  API_BASE_URL: 'https://api.test.invalid',
  WEB_BASE_URL: 'https://app.test.invalid',
  DATABASE_URL: database ?? '',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  S3_BUCKET: 'wea-attachments',
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

async function createContext(): Promise<Container> {
  const { NestFactory } = await import('@nestjs/core');
  const { WorkerModule } = (await import(new URL('worker.module.js', DIST).href)) as {
    WorkerModule: unknown;
  };

  // `abortOnError: false` is what makes a failure observable. At its default,
  // Nest exits the whole test process on a resolution error.
  return (await NestFactory.createApplicationContext(WorkerModule as never, {
    abortOnError: false,
    logger: false,
  })) as unknown as Container;
}

describe.skipIf(!runnable)('the worker starts (compiled output)', () => {
  let app: Container;
  let saved: NodeJS.ProcessEnv;

  beforeAll(async () => {
    saved = { ...process.env };
    Object.assign(process.env, FAKE_ENV);
    app = await createContext();
  });

  afterAll(async () => {
    await app?.close();
    process.env = saved;
  });

  it('resolves every processor and service through the container', () => {
    // Reaching this line is the assertion — `createApplicationContext` throws
    // on any unresolvable dependency anywhere in the graph, and this graph is
    // the larger of the two.
    expect(app).toBeDefined();
  });

  it('can build the ConfigService every processor depends on', async () => {
    const { ConfigService } = (await import(new URL('config/config.service.js', DIST).href)) as {
      ConfigService: unknown;
    };
    const config = app.get(ConfigService) as { env: Record<string, string> };

    expect(config.env['NODE_ENV']).toBe('test');
  });

  it('wires the logger the config module provides', () => {
    expect(app.get('LOGGER')).toHaveProperty('info');
  });
});
