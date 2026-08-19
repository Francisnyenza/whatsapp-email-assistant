import { Injectable, Optional } from '@nestjs/common';
import { loadEnv, type Env } from '@wea/shared';

/**
 * Validated configuration, loaded once at construction.
 *
 * The whole environment is parsed here rather than read ad hoc through
 * `process.env`, so a missing variable is a boot failure with every offending
 * name listed, not a `undefined` that surfaces hours later under load.
 */
@Injectable()
export class ConfigService {
  readonly env: Env;

  /**
   * `@Optional()` is load-bearing, not defensive.
   *
   * `emitDecoratorMetadata` turns `NodeJS.ProcessEnv` into `design:paramtypes:
   * [Object]`, and a default value is invisible to that metadata — dependency
   * injection always passes its own resolved argument. So Nest saw a required
   * dependency of type `Object`, could not find a provider for it, and refused
   * to build this class. Since everything downstream needs configuration, that
   * meant the application could not start at all.
   *
   * `@Optional()` makes Nest pass `undefined` instead of throwing, and
   * `undefined` is exactly what triggers a JavaScript default parameter — so
   * the container gets `process.env` and `new ConfigService(fake)` still works
   * in a test.
   */
  constructor(@Optional() source: NodeJS.ProcessEnv = process.env) {
    this.env = loadEnv(source);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
