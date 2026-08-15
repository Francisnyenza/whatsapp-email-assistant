/**
 * The client the dashboard talks to the API through.
 *
 * Three decisions here are worth more than the code that implements them.
 *
 * **The access token lives in memory, not in `localStorage`.** A token in
 * `localStorage` survives a tab close, which sounds like a feature and is
 * actually the property that makes any XSS on this origin a permanent account
 * takeover — the attacker reads it once and keeps it. In memory it dies with
 * the tab, and the refresh token in an HttpOnly cookie is what survives instead,
 * where script cannot reach it.
 *
 * **A 401 refreshes once and retries once.** Not a loop: a refresh token that is
 * genuinely dead would otherwise produce an infinite pair of requests, which
 * looks to the user like a hung page and to the API like an attack.
 *
 * **Concurrent 401s share one refresh.** Six widgets loading at once must not
 * each rotate the token — refresh tokens rotate on use, so five of those six
 * would present an already-rotated token, and the API is right to treat that as
 * a stolen-token family and revoke everything.
 */

export interface ApiError extends Error {
  status: number;
  code?: string;
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

export const apiBaseUrl = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001';

export async function api<T>(
  path: string,
  init: RequestInit & { retryOn401?: boolean } = {},
): Promise<T> {
  const { retryOn401 = true, ...rest } = init;

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(rest.headers as Record<string, string> | undefined),
    },
    // The refresh token rides in an HttpOnly cookie, so every request has to
    // carry credentials or the refresh below has nothing to work with.
    credentials: 'include',
  });

  if (response.status === 401 && retryOn401) {
    // Once. A dead refresh token would otherwise loop forever.
    const refreshed = await refreshOnce();
    if (refreshed) return api<T>(path, { ...init, retryOn401: false });
  }

  if (!response.ok) throw await toError(response);

  // 204 carries no body, and parsing an empty one throws — which would turn a
  // successful disconnect into a failure.
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

/**
 * Refreshes the access token, at most once at a time.
 *
 * The shared promise is the important part. Refresh tokens rotate on use, so
 * two concurrent refreshes mean the second presents an already-rotated token —
 * which the API correctly reads as a stolen-token family and answers by
 * revoking every session the user has.
 */
async function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        accessToken = null;
        return false;
      }

      const body = (await response.json()) as { accessToken?: string };
      if (!body.accessToken) {
        accessToken = null;
        return false;
      }

      accessToken = body.accessToken;
      return true;
    } catch {
      // A network failure is not a signed-out user. The token is cleared anyway
      // because we can no longer prove it is good, and the caller shows the
      // sign-in screen — which is recoverable, unlike acting on a stale token.
      accessToken = null;
      return false;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * The API's error, as an Error.
 *
 * `publicMessage` is what the API deliberately chose to show a user; `message`
 * is for us. Preferring the first is what stops an internal error code
 * appearing in a toast, which is noise at best and a disclosure at worst.
 */
async function toError(response: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; publicMessage?: string } } = {};

  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A non-JSON error body — a proxy timing out, usually. The status is still
    // worth reporting.
  }

  const error = new Error(
    body.error?.publicMessage ?? body.error?.message ?? `Request failed (${response.status})`,
  ) as ApiError;

  error.status = response.status;
  if (body.error?.code) error.code = body.error.code;

  return error;
}

/* ------------------------------- endpoints -------------------------------- */

export interface ConnectedAccount {
  id: string;
  provider: string;
  emailAddress: string;
  isPrimary: boolean;
  connectedAt: string;
  lastSyncedAt: string | null;
  health:
    | { state: 'healthy' }
    | { state: 'degraded'; reason: string }
    | { state: 'reconnect'; reason: string };
}

export interface Preferences {
  notificationMode: string;
  minimumPriority: string;
  digestTimes: string[];
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  mutedCategories: string[];
  mutedSenders: string[];
  includeSummary: boolean;
  signature: string | null;
}

export interface PhoneStatus {
  phoneNumber: string | null;
  verified: boolean;
  codePending: boolean;
}

export const endpoints = {
  signIn: (email: string, password: string) =>
    api<{ accessToken: string; twoFactorRequired?: boolean }>('/v1/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      // Not yet signed in, so a 401 here is the answer rather than a stale
      // token — retrying it would just ask the same wrong password twice.
      retryOn401: false,
    }),

  me: () => api<{ id: string; email: string }>('/v1/auth/me'),

  accounts: () => api<ConnectedAccount[]>('/v1/accounts'),

  disconnect: (id: string) => api<void>(`/v1/accounts/${id}`, { method: 'DELETE' }),

  /**
   * Asks the API where to send the user for consent.
   *
   * The API returns a URL rather than redirecting, because a browser navigating
   * to a redirect endpoint cannot send a bearer token — so a redirect there
   * would have to be unauthenticated, and anyone could start a flow that
   * attaches a mailbox to someone else's account.
   */
  connect: (provider: 'google' | 'microsoft', returnTo?: string) =>
    api<{ url: string }>(
      `/v1/oauth/${provider}/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`,
    ),

  preferences: () => api<Preferences>('/v1/preferences'),

  updatePreferences: (patch: Partial<Preferences>) =>
    api<Preferences>('/v1/preferences', { method: 'PATCH', body: JSON.stringify(patch) }),

  phone: () => api<PhoneStatus>('/v1/auth/phone'),

  startPhoneVerification: () =>
    api<{ code: string; expiresAt: string; sendTo: string | null }>('/v1/auth/phone/start', {
      method: 'POST',
    }),

  unlinkPhone: () => api<void>('/v1/auth/phone/unlink', { method: 'POST' }),
};
