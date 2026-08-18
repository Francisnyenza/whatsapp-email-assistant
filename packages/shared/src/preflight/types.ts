/**
 * The vocabulary of the preflight check.
 *
 * Every external seam in this product fails silently. A WhatsApp token that
 * expired overnight, a WABA nobody subscribed the app to, a redirect URI off by
 * a trailing slash — none of them raise an error anywhere. They produce a
 * system that starts cleanly, passes its health checks, and never delivers a
 * message. The environment schema catches a variable that is missing or
 * malformed; it cannot catch one that is well-formed and wrong.
 *
 * So the unit here is not "did the call succeed" but "what do I do about it".
 * A check that reports `fail` without a `fix` has told the operator something
 * they already knew.
 */

/**
 * How bad it is.
 *
 * `fail` means a core promise of the product does not work — mail will not
 * arrive, or replies will not send. `warn` means it works but differently from
 * what the README says, which is a category worth its own level: polling
 * instead of push is a legitimate way to run, and reporting it as a failure
 * would train people to ignore failures.
 */
export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  /** Shown in the report. Short enough to scan a column of them. */
  name: string;
  level: CheckLevel;
  /** What was found, in one line. */
  detail: string;
  /**
   * What to do about it, in the operator's terms — a console to open, a value
   * to change. Omitted only when the level is `ok`.
   */
  fix?: string;
}

/**
 * The result of one HTTP probe, reduced to what an interpreter needs.
 *
 * Deliberately not a `Response`. Keeping the interpreters pure over this shape
 * is what makes the remediation text — the actual product of this module —
 * testable without a network, and it is the text that is easy to get wrong.
 */
export type Probe =
  | { kind: 'response'; status: number; body: unknown }
  /** No response at all: DNS, TLS, connection refused, timeout. */
  | { kind: 'unreachable'; error: string };

/** Meta's error envelope, as much of it as the interpreters read. */
export interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

/** Reads Meta's numeric error code out of a body of unknown shape. */
export function metaErrorCode(body: unknown): number | undefined {
  const code = (body as MetaErrorBody | null)?.error?.code;
  return typeof code === 'number' ? code : undefined;
}

/** Reads Meta's human-readable message, which is usually the most useful line available. */
export function metaErrorMessage(body: unknown): string | undefined {
  const message = (body as MetaErrorBody | null)?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
