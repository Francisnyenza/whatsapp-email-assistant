import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { existsSync } from 'node:fs';

/**
 * NestJS resolves constructor dependencies from `design:paramtypes`, metadata
 * TypeScript emits only for **value** imports. Rewriting an injected class to
 * `import type` erases the runtime binding, and the container then fails at boot
 * with "Nest can't resolve dependencies" — invisible to the type checker and to
 * every unit test that constructs the class by hand. An `eslint --fix` did
 * exactly that once, which is why this exists.
 *
 * The worker's version also walks the module's provider list, because a
 * processor that is written but never registered is a queue nobody consumes.
 * Nothing else in the suite would notice: every unit test constructs the
 * processors directly.
 *
 * Runs against `dist/`, not `src/` — vitest transpiles with esbuild, which does
 * not implement emitDecoratorMetadata at all, so only the tsc output carries the
 * metadata. That output is also what runs in production. Requires `pnpm build`.
 */
const DIST = new URL('../dist/', import.meta.url);
const built = existsSync(new URL('worker.module.js', DIST));

describe.skipIf(!built)('dependency injection metadata (compiled output)', () => {
  it('registers every processor, so every queue has a consumer', async () => {
    const mod = (await import(new URL('worker.module.js', DIST).href)) as Record<string, object>;
    const providers = Reflect.getMetadata('providers', mod.WorkerModule!) as
      Array<{ name?: string }> | undefined;

    expect(providers, 'WorkerModule declares no providers').toBeDefined();
    const names = providers!.map((p) => p.name);

    for (const required of [
      'IngestProcessor',
      'NotifyProcessor',
      'SendProcessor',
      'CommandsProcessor',
      'SyncProcessor',
      'AiProcessor',
      // Without the scheduler nothing ever fires the sweep, and every Gmail
      // watch lapses seven days after it was created.
      'SyncScheduler',
      // Without it, `search` and the standing lists have nothing to answer them.
      'MailboxQueryService',
      'AssistantService',
    ]) {
      expect(names, `${required} is not registered in WorkerModule`).toContain(required);
    }
  });

  const cases: Array<[string, string, number]> = [
    ['processors/sync.processor.js', 'SyncProcessor', 8],
    ['processors/commands.processor.js', 'CommandsProcessor', 13],
    ['processors/notify.processor.js', 'NotifyProcessor', 4],
    ['processors/ai.processor.js', 'AiProcessor', 8],
    ['services/ai.service.js', 'AiService', 3],
    ['repositories/analysis.repository.js', 'AnalysisRepository', 1],
    ['queue/sync.scheduler.js', 'SyncScheduler', 2],
    ['repositories/watch.repository.js', 'WatchRepository', 1],
    ['repositories/retention.repository.js', 'RetentionRepository', 1],
    ['services/forward-composer.js', 'ForwardComposer', 4],
    ['processors/ingest.processor.js', 'IngestProcessor', 5],
    ['queue/queue.producer.js', 'QueueProducer', 1],
    ['repositories/search.repository.js', 'SearchRepository', 1],
    ['services/mailbox-query.service.js', 'MailboxQueryService', 5],
    ['services/assistant.service.js', 'AssistantService', 5],
  ];

  for (const [file, exported, expectedCount] of cases) {
    it(`${exported} exposes resolvable parameter types`, async () => {
      const mod = (await import(new URL(file, DIST).href)) as Record<string, object>;
      const target = mod[exported]!;
      const types = Reflect.getMetadata('design:paramtypes', target) as unknown[] | undefined;

      expect(types, `${exported} has no design:paramtypes — DI will fail at boot`).toBeDefined();
      expect(types).toHaveLength(expectedCount);

      types!.forEach((t, i) => {
        // An erased import shows up as undefined here. Object is what an
        // @Inject()-token parameter degrades to, which is fine — those resolve
        // by token, not by type.
        expect(t, `${exported} parameter ${i} lost its runtime type`).toBeDefined();
      });
    });
  }
});
