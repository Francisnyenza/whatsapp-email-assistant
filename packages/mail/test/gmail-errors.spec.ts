import { describe, it, expect } from 'vitest';
import { mapGmailError } from '../src/index.js';
import { AppError } from '@wea/shared';

/**
 * How Gmail's failures are classified.
 *
 * The queue's behaviour hangs off this. Getting it wrong is not cosmetic: a
 * revoked grant retried forever looks like a transient outage instead of a user
 * who needs to reconnect, and a rate limit treated as fatal drops mail that
 * would have arrived a second later.
 */

const gmailError = (code: number, reason?: string, message = 'boom') => ({
  code,
  message,
  ...(reason ? { errors: [{ reason, message }] } : {}),
});

describe('a revoked grant is never retried', () => {
  it('maps 401 to a reconnect prompt', () => {
    const mapped = mapGmailError(gmailError(401, 'authError'));

    expect(mapped.code).toBe('PROVIDER_UNAUTHORIZED');
    expect(mapped.retryable).toBe(false);
    expect(mapped.publicMessage).toContain('reconnect');
  });

  it('tells the user what to do, not what broke', () => {
    const mapped = mapGmailError(gmailError(401));
    expect(mapped.publicMessage).not.toContain('401');
    expect(mapped.publicMessage).not.toContain('boom');
  });
});

describe('403 is forked on reason, not treated as one thing', () => {
  // Gmail uses 403 for both "slow down" and "you may not do this". Treating
  // them alike is either a hot loop or a silently dropped user.

  it('retries a rate limit', () => {
    for (const reason of [
      'rateLimitExceeded',
      'userRateLimitExceeded',
      'quotaExceeded',
      'backendError',
    ]) {
      const mapped = mapGmailError(gmailError(403, reason));
      expect(mapped.code, reason).toBe('PROVIDER_RATE_LIMITED');
      expect(mapped.retryable, reason).toBe(true);
    }
  });

  it('does not retry a permission failure', () => {
    for (const reason of ['insufficientPermissions', 'forbidden', 'domainPolicy']) {
      const mapped = mapGmailError(gmailError(403, reason));
      expect(mapped.code, reason).toBe('PROVIDER_UNAUTHORIZED');
      expect(mapped.retryable, reason).toBe(false);
    }
  });

  it('treats an unrecognised 403 as permission rather than rate limit', () => {
    // Retrying a genuine permission failure is the more expensive mistake, so
    // the unknown case fails closed.
    const mapped = mapGmailError(gmailError(403, 'somethingNew'));
    expect(mapped.retryable).toBe(false);
  });
});

describe('other statuses', () => {
  it('retries 429', () => {
    const mapped = mapGmailError(gmailError(429));
    expect(mapped.code).toBe('PROVIDER_RATE_LIMITED');
    expect(mapped.retryable).toBe(true);
  });

  it('retries 5xx', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(mapGmailError(gmailError(status)).retryable, String(status)).toBe(true);
    }
  });

  it('does not retry a 404 — the message is genuinely gone', () => {
    const mapped = mapGmailError(gmailError(404));
    expect(mapped.code).toBe('NOT_FOUND');
    expect(mapped.retryable).toBe(false);
    expect(mapped.publicMessage).toContain('no longer exists');
  });

  it('does not retry a 400 — that is our bug, not a blip', () => {
    // An identical malformed request will be malformed on the fourth attempt too.
    const mapped = mapGmailError(gmailError(400, 'invalidArgument'));
    expect(mapped.retryable).toBe(false);
  });

  it('flags 412 distinctly so the caller can resync', () => {
    // A history cursor too old to serve is a normal operating condition for a
    // paused account, not an incident.
    const mapped = mapGmailError(gmailError(412, 'failedPrecondition'));
    expect(mapped.code).toBe('CONFLICT');
    expect(mapped.retryable).toBe(false);
  });
});

describe('transport failures', () => {
  it('retries connection errors that carry no HTTP status', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      const mapped = mapGmailError({ code, message: 'socket hang up' });
      expect(mapped.retryable, code).toBe(true);
    }
  });

  it('retries an error with no status at all', () => {
    expect(mapGmailError(new Error('unknown failure')).retryable).toBe(true);
  });
});

describe('shape handling', () => {
  it('reads a status nested under response', () => {
    // googleapis surfaces errors in more than one shape depending on the call.
    const mapped = mapGmailError({ response: { status: 401 }, message: 'unauthorized' });
    expect(mapped.code).toBe('PROVIDER_UNAUTHORIZED');
  });

  it('passes an AppError through untouched', () => {
    const original = new AppError('QUOTA_EXCEEDED', 'plan limit');
    expect(mapGmailError(original)).toBe(original);
  });

  it('keeps context for the logs without leaking it to the user', () => {
    const mapped = mapGmailError(gmailError(403, 'quotaExceeded'), {
      accountId: 'acct-1',
      op: 'messages.send',
    });

    expect(mapped.context).toMatchObject({ accountId: 'acct-1', op: 'messages.send', status: 403 });
    expect(mapped.publicMessage).not.toContain('acct-1');
  });

  it('does not throw on a malformed error object', () => {
    for (const input of [null, undefined, 'a string', 42, {}, { errors: [] }]) {
      expect(() => mapGmailError(input), String(input)).not.toThrow();
    }
  });
});
