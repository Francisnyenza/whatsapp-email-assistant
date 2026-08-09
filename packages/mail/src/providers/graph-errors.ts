import { AppError } from '@wea/shared';

/**
 * Mapping Microsoft Graph's failures onto ours.
 *
 * Same stakes as the Gmail version — the queue's retry behaviour hangs off this
 * classification, and getting it wrong means either a hot loop against a quota
 * we do not have or a revoked grant that looks like a transient outage forever.
 *
 * What is *different* from Gmail is where the information lives. Google puts a
 * machine-readable `reason` in an `errors[]` array; Graph puts a string code in
 * `error.code` and, for throttling, the retry delay in a `Retry-After` header
 * rather than the body. So this maps on the code string, and the codes below
 * are the ones that actually appear rather than the full published list.
 */

export interface GraphApiError {
  status?: number;
  /** The parsed `error` object from Graph's JSON body. */
  code?: string;
  message?: string;
  /** Seconds, from the `Retry-After` header when Graph sent one. */
  retryAfterSeconds?: number;
}

/**
 * Graph codes that mean "the grant is gone" rather than "this request was
 * wrong". Each of these needs the user to reconnect; none is fixed by retrying.
 */
const REVOKED_CODES = new Set([
  'InvalidAuthenticationToken',
  'TokenExpired',
  'CompactToken_ParsingFailure',
  'AuthenticationFailure',
  'unauthenticated',
]);

/**
 * Codes inside a 403 that mean "you may not do this". Graph reuses 403 for
 * throttling too, which is the same fork Gmail has and the same trap.
 */
const FORBIDDEN_CODES = new Set([
  'ErrorAccessDenied',
  'AccessDenied',
  'ErrorInsufficientPermissionsInAccessToken',
  'MailboxNotEnabledForRESTAPI',
]);

/**
 * Transient by nature. `ApplicationThrottled` and `ActivityLimitReached` are
 * Graph's rate limits; the mailbox-level ones are real but clear on their own.
 */
const TRANSIENT_CODES = new Set([
  'ApplicationThrottled',
  'ActivityLimitReached',
  'ServiceUnavailable',
  'ErrorTimeoutExpired',
  'ErrorServerBusy',
  'ErrorMailboxStoreUnavailable',
  'UnknownError',
]);

export function mapGraphError(err: unknown, context: Record<string, unknown> = {}): AppError {
  if (AppError.isAppError(err)) return err;

  // This runs inside catch blocks. Throwing here would turn a handled failure
  // into an unhandled one and take the worker down, so anything that is not an
  // object is normalized rather than dereferenced.
  if (err === null || err === undefined || typeof err !== 'object') {
    return new AppError('PROVIDER_ERROR', err === undefined ? 'Unknown error' : String(err), {
      context,
      retryable: true,
    });
  }

  const api = err as GraphApiError;
  const status = api.status ?? 0;
  const code = api.code ?? '';
  const message = api.message ?? `Microsoft Graph returned ${status}`;
  const ctx = { ...context, status, code, retryAfterSeconds: api.retryAfterSeconds };

  if (status === 401 || REVOKED_CODES.has(code)) {
    return new AppError('PROVIDER_UNAUTHORIZED', message, {
      context: ctx,
      retryable: false,
      publicMessage: 'We lost access to your mailbox. Please reconnect it.',
    });
  }

  if (status === 403) {
    // The fork that matters. Graph returns 403 both for "slow down" and for
    // "this token cannot do that", and treating them alike is either a hot loop
    // or a user dropped for no reason.
    if (TRANSIENT_CODES.has(code)) {
      return new AppError('PROVIDER_RATE_LIMITED', message, { context: ctx, retryable: true });
    }
    return new AppError('PROVIDER_UNAUTHORIZED', message, {
      context: ctx,
      retryable: false,
      publicMessage: FORBIDDEN_CODES.has(code)
        ? 'Your organisation has not granted the access we need to this mailbox.'
        : 'We lost access to your mailbox. Please reconnect it.',
    });
  }

  if (status === 429) {
    return new AppError('PROVIDER_RATE_LIMITED', message, { context: ctx, retryable: true });
  }

  if (status === 404) {
    // A message that has been moved or deleted. Permanent for this id.
    return new AppError('NOT_FOUND', message, { context: ctx, retryable: false });
  }

  if (status === 410) {
    // Graph's "your delta token is too old". The caller resyncs from scratch
    // rather than retrying, so this must not be retryable.
    return new AppError('CONFLICT', message, { context: ctx, retryable: false });
  }

  if (status === 413) {
    return new AppError('PAYLOAD_TOO_LARGE', message, { context: ctx, retryable: false });
  }

  if (status >= 500 || TRANSIENT_CODES.has(code)) {
    return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: true });
  }

  if (status >= 400) {
    // A malformed request will be exactly as malformed on the fourth attempt.
    return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: false });
  }

  return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: true });
}

/**
 * Whether the delta token has aged out and a full resync is needed.
 *
 * Graph expires delta tokens after roughly 30 days, and answers a stale one with
 * `410 Gone` and `syncStateNotFound`. That is an ordinary operating condition
 * for a paused account, not an incident — the same shape as Gmail's expired
 * history id, and handled the same way.
 */
export function isDeltaTokenExpired(err: unknown): boolean {
  if (AppError.isAppError(err)) {
    return err.code === 'CONFLICT' && String(err.context?.['code'] ?? '').includes('syncState');
  }

  if (!err || typeof err !== 'object') return false;
  const api = err as GraphApiError;
  return api.status === 410 || (api.code ?? '').includes('syncState');
}
