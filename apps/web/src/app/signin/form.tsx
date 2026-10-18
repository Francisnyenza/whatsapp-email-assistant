'use client';

import { useState, type FormEvent } from 'react';
import { useSession } from '@/lib/session';

/**
 * Sign in, or create an account.
 *
 * One form with a toggle rather than two routes: the fields are the same, and a
 * first-time visitor who lands here should not have to hunt for the way in.
 * The password minimum is the API's (`MIN_PASSWORD_LENGTH`); it is repeated
 * here only so the browser can say so before a round trip, and the API's
 * message is still what shows if the two ever disagree.
 */
const MIN_PASSWORD_LENGTH = 12;

export function SignInForm() {
  const { signIn, signUp } = useSession();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const creating = mode === 'signup';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await (creating ? signUp(email, password) : signIn(email, password));
    } catch (err) {
      // Whatever the API chose to say. It deliberately does not distinguish a
      // wrong password from an unknown address, and neither does this.
      setError(
        err instanceof Error
          ? err.message
          : creating
            ? 'Could not create the account.'
            : 'Could not sign in.',
      );
    } finally {
      setBusy(false);
    }
  }

  function toggle() {
    setMode(creating ? 'signin' : 'signup');
    setError(null);
  }

  return (
    <form onSubmit={submit}>
      <h1>{creating ? 'Create your account' : 'Sign in'}</h1>
      <p>Read and answer your email from WhatsApp.</p>

      <div className="card">
        <label>
          <span>Email</span>
          <input
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>

        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoComplete={creating ? 'new-password' : 'current-password'}
            minLength={creating ? MIN_PASSWORD_LENGTH : undefined}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {creating ? (
          <p style={{ marginTop: 0 }}>
            At least {MIN_PASSWORD_LENGTH} characters. This is a password for this dashboard only —
            never your email password.
          </p>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

        <button className="primary" type="submit" disabled={busy}>
          {busy
            ? creating
              ? 'Creating…'
              : 'Signing in…'
            : creating
              ? 'Create account'
              : 'Sign in'}
        </button>
      </div>

      <p>
        {creating ? 'Already have an account?' : 'New here?'}{' '}
        <button type="button" onClick={toggle} disabled={busy}>
          {creating ? 'Sign in' : 'Create an account'}
        </button>
      </p>
    </form>
  );
}
