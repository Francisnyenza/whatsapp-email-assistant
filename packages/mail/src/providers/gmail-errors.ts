import { AppError } from '@wea/shared';

/**
 * Mapping Gmail's failures onto ours.
 *
 * This is not bookkeeping — the queue's behaviour hangs off it. A retryable
 * error costs a few seconds and succeeds; a non-retryable one retried five times
 * burns quota we do not have and delays the dead-letter that would have told an
 * operator something is wrong. Worse, a revoked grant retried forever looks like
 * a transient outage instead of a user who needs to reconnect.
 *
 * The classification below is deliberately explicit rather than "4xx is fatal,
 * 5xx is transient", because Gmail violates that in both directions: 403 covers
 * both rate limits (retry) and insufficient permission (do not), and 404 on a
 * message is permanent while 404 on a batch endpoint is not.
 */

export interface GmailApiError {
  code?: number;
  status?: number;
  message?: string;
  errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  response?: { status?: number; data?: { error?: { message?: string; errors?: unknown[] } } };
}

/**
 * Reasons Gmail returns inside a 403. Only some mean "stop".
 */
const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
]);

const PERMANENT_REASONS = new Set([
  'insufficientPermissions',
  'forbidden',
  'domainPolicy',
  'failedPrecondition',
]);

export function mapGmailError(err: unknown, context: Record<string, unknown> = {}): AppError {
  if (AppError.isAppError(err)) return err;

  // This runs inside catch blocks. Throwing here would turn a handled failure
  // into an unhandled one and take the worker down with it, so anything that is
  // not an object is normalized rather than dereferenced.
  if (err === null || err === undefined || typeof err !== 'object') {
    return new AppError('PROVIDER_ERROR', err === undefined ? 'Unknown error' : String(err), {
      context,
      retryable: true,
    });
  }

  const api = err as GmailApiError;
  const status = api.code ?? api.status ?? api.response?.status ?? 0;
  const reason = api.errors?.[0]?.reason ?? '';
  const message = api.message ?? api.errors?.[0]?.message ?? `Gmail returned ${status}`;
  const ctx = { ...context, status, reason };

  // 401 — the grant is gone. Retrying cannot fix it; the user must reconnect.
  if (status === 401) {
    return new AppError('PROVIDER_UNAUTHORIZED', message, {
      context: ctx,
      retryable: false,
      publicMessage: 'We lost access to your mailbox. Please reconnect it.',
    });
  }

  if (status === 403) {
    // The important fork. Gmail uses 403 for both "slow down" and "you may not
    // do this", and treating them alike is either a hot loop or a dropped user.
    if (RATE_LIMIT_REASONS.has(reason)) {
      return new AppError('PROVIDER_RATE_LIMITED', message, { context: ctx, retryable: true });
    }
    if (PERMANENT_REASONS.has(reason)) {
      return new AppError('PROVIDER_UNAUTHORIZED', message, {
        context: ctx,
        retryable: false,
        publicMessage: 'We do not have permission for that. Please reconnect your mailbox.',
      });
    }
    // Unrecognized 403: treat as permission rather than rate limit. Retrying a
    // genuine permission failure is the more expensive mistake.
    return new AppError('PROVIDER_UNAUTHORIZED', message, { context: ctx, retryable: false });
  }

  if (status === 429) {
    return new AppError('PROVIDER_RATE_LIMITED', message, { context: ctx, retryable: true });
  }

  // 404 — the message is gone. The user deleted it elsewhere, or a history
  // record outlived its message. Never retryable, and not really an error.
  if (status === 404) {
    return new AppError('NOT_FOUND', message, {
      context: ctx,
      retryable: false,
      publicMessage: 'That email no longer exists in your mailbox.',
    });
  }

  // 400 — our bug, almost always a malformed request. Retrying an identical
  // malformed request just burns quota.
  if (status === 400) {
    return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: false });
  }

  // 412 — Gmail's signal that a history cursor is too old to serve. The caller
  // handles this by falling back to a full resync, so it is surfaced distinctly.
  if (status === 412) {
    return new AppError('CONFLICT', message, {
      context: ctx,
      retryable: false,
      publicMessage: 'We need to resynchronise your mailbox.',
    });
  }

  if (status >= 500) {
    return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: true });
  }

  // Transport failures — DNS, resets, timeouts — arrive with no HTTP status.
  const code = (err as { code?: string }).code;
  if (typeof code === 'string' && TRANSPORT_ERRORS.has(code)) {
    return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: true });
  }

  return new AppError('PROVIDER_ERROR', message, { context: ctx, retryable: status === 0 });
}

const TRANSPORT_ERRORS = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * True when a history cursor is too old and a full resync is needed.
 *
 * Gmail keeps history for about a week. An account that was paused, or whose
 * watch lapsed over a holiday, comes back to a 404/412 here rather than to
 * silence — so this is a normal operating condition, not an incident.
 */
export function isHistoryExpired(err: unknown): boolean {
  const mapped = mapGmailError(err);
  return (
    mapped.code === 'CONFLICT' ||
    (mapped.code === 'NOT_FOUND' && mapped.context['historyId'] !== undefined)
  );
}
