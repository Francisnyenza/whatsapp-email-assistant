/**
 * Application error taxonomy.
 *
 * Two audiences, two messages: `message` is for logs and engineers, `publicMessage`
 * is what an end user or API client sees. Nothing sensitive crosses that line —
 * "account 7f3a… token decryption failed with keyVersion 2" is a log; "We couldn't
 * reach your mailbox. Please reconnect it." is the response.
 */

export type ErrorCode =
  // 4xx
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'TWO_FACTOR_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'PAYMENT_REQUIRED'
  // integration
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAUTHORIZED'
  | 'PROVIDER_RATE_LIMITED'
  | 'WHATSAPP_SESSION_EXPIRED'
  | 'AI_UNAVAILABLE'
  | 'AI_INVALID_OUTPUT'
  // 5xx
  | 'INTERNAL'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'ENCRYPTION_FAILURE';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TWO_FACTOR_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  PAYMENT_REQUIRED: 402,
  PROVIDER_ERROR: 502,
  PROVIDER_UNAUTHORIZED: 401,
  PROVIDER_RATE_LIMITED: 429,
  WHATSAPP_SESSION_EXPIRED: 409,
  AI_UNAVAILABLE: 503,
  AI_INVALID_OUTPUT: 502,
  INTERNAL: 500,
  DEPENDENCY_UNAVAILABLE: 503,
  ENCRYPTION_FAILURE: 500,
};

/**
 * Errors worth retrying. Everything else is a permanent failure and should go
 * straight to the DLQ rather than burning four more attempts.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED',
  'RATE_LIMITED',
  'AI_UNAVAILABLE',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL',
]);

export interface AppErrorOptions {
  /** Safe to show a user. Defaults to a generic message for the code. */
  publicMessage?: string;
  /** Structured context for logs. Must not contain secrets or message bodies. */
  context?: Record<string, unknown>;
  cause?: unknown;
  /** Overrides the code's default retryability. */
  retryable?: boolean;
  /** Seconds to wait, when a provider told us. */
  retryAfterSeconds?: number;
}

const GENERIC_PUBLIC_MESSAGE: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'That request was not valid.',
  VALIDATION_FAILED: 'Some of the information provided was not valid.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  INVALID_CREDENTIALS: 'That email or password is incorrect.',
  TWO_FACTOR_REQUIRED: 'Enter your two-factor code to continue.',
  FORBIDDEN: "You don't have access to this.",
  NOT_FOUND: 'We could not find that.',
  CONFLICT: 'That conflicts with something that already exists.',
  RATE_LIMITED: "That's a lot of requests — please slow down.",
  QUOTA_EXCEEDED: "You've reached your plan's limit.",
  PAYMENT_REQUIRED: 'This feature needs an active subscription.',
  PROVIDER_ERROR: 'Your email provider had a problem. We will retry shortly.',
  PROVIDER_UNAUTHORIZED: 'We lost access to your mailbox. Please reconnect it.',
  PROVIDER_RATE_LIMITED: 'Your email provider is rate limiting us. We will retry shortly.',
  WHATSAPP_SESSION_EXPIRED: 'Send us a WhatsApp message first so we can reply.',
  AI_UNAVAILABLE: 'The assistant is briefly unavailable. Your email is unaffected.',
  AI_INVALID_OUTPUT: 'The assistant returned something we could not use.',
  INTERNAL: 'Something went wrong on our side.',
  DEPENDENCY_UNAVAILABLE: 'A service we depend on is unavailable. We will retry shortly.',
  ENCRYPTION_FAILURE: 'Something went wrong on our side.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly publicMessage: string;
  readonly context: Record<string, unknown>;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.publicMessage =
      options.publicMessage ?? GENERIC_PUBLIC_MESSAGE[code] ?? 'Something went wrong.';
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace?.(this, AppError);
  }

  /** The response body shape. Deliberately excludes `message` and `context`. */
  toJSON(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        ...(requestId ? { requestId } : {}),
        ...(this.retryAfterSeconds ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      },
    };
  }

  static isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  }

  /** Wraps an unknown thrown value so callers always have an AppError. */
  static from(err: unknown, fallbackCode: ErrorCode = 'INTERNAL'): AppError {
    if (AppError.isAppError(err)) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AppError(fallbackCode, message, { cause: err });
  }
}
