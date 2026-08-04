import pino, { type Logger } from 'pino';
import { redact, type Env } from '@wea/shared';

/**
 * The application logger.
 *
 * We operate on people's private correspondence, so redaction is wired into the
 * logger itself rather than left to call sites. A `logger.info({ message })`
 * written in a hurry six months from now still cannot leak an email body.
 */
export function createLogger(env: Env): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: env.OTEL_SERVICE_NAME, env: env.NODE_ENV },
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
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export type { Logger };
