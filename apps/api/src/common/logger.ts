import { createRequire } from 'node:module';
import pino, { type Logger } from 'pino';
import { redact, type Env } from '@wea/shared';

/**
 * The application logger.
 *
 * We operate on people's private correspondence, so redaction is wired into the
 * logger itself rather than left to call sites. A `logger.info({ message })`
 * written in a hurry six months from now still cannot leak an email body.
 */

/**
 * Whether pretty output is actually available.
 *
 * pino resolves a transport target in a worker thread, and a target it cannot
 * find throws at construction — which happens during bootstrap, before there is
 * an application. `pino-pretty` is a development dependency, so it is missing
 * from exactly the place that matters most: a production image built with
 * `pnpm deploy --prod`, run once with `NODE_ENV=development` to debug
 * something. The process then refuses to start, and the reason is a missing
 * log formatter.
 *
 * Colour in a terminal is not worth a process that will not boot, so this
 * checks rather than assumes and falls back to the JSON that production uses.
 */
function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * The name this process reports as.
 *
 * Passed in rather than read from the environment, because the environment
 * schema is shared by both services and a single default there labelled the
 * worker's logs as the API's.
 */
const SERVICE_NAME = 'wea-api';

export function createLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: env.OTEL_SERVICE_NAME ?? SERVICE_NAME, env: env.NODE_ENV },
    // Every logged object passes through redact(): secret-shaped keys are
    // dropped, correspondence becomes a stable fingerprint, and addresses and
    // phone numbers are masked wherever they appear.
    formatters: {
      log: (object) => redact(object) as Record<string, unknown>,
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Pretty output is a development nicety; production ships JSON for the
    // aggregator.
    ...(env.NODE_ENV === 'development' && prettyAvailable()
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export type { Logger };
