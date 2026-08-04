import { Injectable } from '@nestjs/common';
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

  constructor(source: NodeJS.ProcessEnv = process.env) {
    this.env = loadEnv(source);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
