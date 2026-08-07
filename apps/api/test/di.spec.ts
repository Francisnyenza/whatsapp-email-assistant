import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { existsSync } from 'node:fs';

/**
 * NestJS resolves constructor dependencies from `design:paramtypes`, metadata
 * TypeScript emits only for **value** imports. Rewriting an injected class to
 * `import type` erases the runtime binding, and the container then fails at boot
 * with "Nest can't resolve dependencies" — invisible to the type checker and to
 * every unit test that constructs the class by hand.
 *
 * An eslint --fix did exactly that to all six injected classes here, so this
 * asserts the metadata survives.
 *
 * It runs against `dist/`, not `src/`: vitest transpiles with esbuild, which
 * does not implement emitDecoratorMetadata at all. Only the tsc output carries
 * the metadata — and the tsc output is what actually runs in production, so it
 * is the right thing to assert on. Requires `pnpm build` first.
 */
const DIST = new URL('../dist/', import.meta.url);
const built = existsSync(new URL('webhooks/whatsapp.controller.js', DIST));

describe.skipIf(!built)('dependency injection metadata (compiled output)', () => {
  const cases: Array<[string, string, string, number]> = [
    [
      'WhatsAppWebhookController',
      'webhooks/whatsapp.controller.js',
      'WhatsAppWebhookController',
      3,
    ],
    ['HealthController', 'health/health.controller.js', 'HealthController', 3],
    ['QueueProducer', 'queue/queue.producer.js', 'QueueProducer', 1],
    ['TwoFactorService', 'auth/two-factor.service.js', 'TwoFactorService', 4],
    ['AuthController', 'auth/auth.controller.js', 'AuthController', 3],
  ];

  for (const [name, file, exported, expectedCount] of cases) {
    it(`${name} exposes resolvable parameter types`, async () => {
      const mod = (await import(new URL(file, DIST).href)) as Record<string, object>;
      const target = mod[exported]!;
      const types = Reflect.getMetadata('design:paramtypes', target) as unknown[] | undefined;

      expect(types, `${name} has no design:paramtypes — DI will fail at boot`).toBeDefined();
      expect(types).toHaveLength(expectedCount);

      types!.forEach((t, i) => {
        // An erased import shows up as undefined here. Object is what an
        // @Inject()-token parameter degrades to, which is fine — those resolve
        // by token, not by type.
        expect(t, `${name} parameter ${i} lost its runtime type`).toBeDefined();
      });
    });
  }
});
