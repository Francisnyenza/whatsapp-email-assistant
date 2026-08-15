'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { endpoints, setAccessToken, hasAccessToken } from './api';

/**
 * Whether we are signed in, and how to find out.
 *
 * The check on mount is a *refresh*, not a `localStorage` read. The access token
 * lives in memory and is gone after a reload; the refresh token is in an
 * HttpOnly cookie the browser still holds, so asking the API to exchange it is
 * both how we learn we are signed in and how we get a usable token back. Reading
 * a token from storage would be simpler and would make any XSS on this origin a
 * permanent takeover.
 */
interface Session {
  status: 'loading' | 'signed-in' | 'signed-out';
  email: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Session['status']>('loading');
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // `me` triggers the client's own refresh-once on a 401, so this single call
    // both restores the session and proves it.
    endpoints
      .me()
      .then((user) => {
        if (cancelled) return;
        setEmail(user.email);
        setStatus('signed-in');
      })
      .catch(() => {
        if (!cancelled) setStatus('signed-out');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (address: string, password: string) => {
    const result = await endpoints.signIn(address, password);

    if (result.twoFactorRequired) {
      // Deliberately not handled here yet. Pretending to sign someone in and
      // then failing every subsequent call is worse than saying so.
      throw new Error(
        'This account uses two-factor authentication, which this screen cannot do yet.',
      );
    }

    setAccessToken(result.accessToken);
    const user = await endpoints.me();
    setEmail(user.email);
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(() => {
    setAccessToken(null);
    setEmail(null);
    setStatus('signed-out');
  }, []);

  return (
    <SessionContext.Provider value={{ status, email, signIn, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside a SessionProvider');
  return session;
}

export { hasAccessToken };
