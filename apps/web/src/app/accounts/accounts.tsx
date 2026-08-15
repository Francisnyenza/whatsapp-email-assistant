'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints, type ConnectedAccount } from '@/lib/api';

/**
 * The connected mailboxes.
 *
 * The health badge is the whole point of this card. "Reconnect" is the only
 * state a user can act on, so it is the only one that gets a button — a
 * "degraded" mailbox is us working around a provider problem and mail still
 * arrives, just a couple of minutes later, and alarming someone about it would
 * teach them to ignore the badge that matters.
 */
export function Accounts() {
  const [accounts, setAccounts] = useState<ConnectedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    endpoints
      .accounts()
      .then(setAccounts)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  async function connect(provider: 'google' | 'microsoft') {
    setBusy(provider);
    setError(null);

    try {
      // The API returns the consent URL rather than redirecting, because a
      // browser navigating to a redirect endpoint cannot send a bearer token.
      const { url } = await endpoints.connect(provider, '/');
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the connection.');
      setBusy(null);
    }
  }

  async function disconnect(account: ConnectedAccount) {
    // Confirmed, because it stops mail arriving and nothing about the button
    // says so. Same reasoning as every destructive verb on the WhatsApp side.
    if (!window.confirm(`Stop receiving mail from ${account.emailAddress}?`)) return;

    setBusy(account.id);
    try {
      await endpoints.disconnect(account.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect that mailbox.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Mailboxes</h2>

      {error ? <p className="error">{error}</p> : null}
      {accounts === null ? <p>Loading…</p> : null}

      {accounts?.length === 0 ? (
        <p>No mailboxes connected yet. Connect one and it starts arriving on WhatsApp.</p>
      ) : null}

      {accounts?.map((account) => (
        <div className="card row" key={account.id}>
          <div>
            <strong>{account.emailAddress}</strong>
            <div className="muted">
              {account.provider === 'gmail' ? 'Gmail' : 'Outlook'} ·{' '}
              {account.lastSyncedAt
                ? `synced ${new Date(account.lastSyncedAt).toLocaleString()}`
                : 'not synced yet'}
            </div>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <HealthBadge health={account.health} />
            <button
              className="danger"
              disabled={busy === account.id}
              onClick={() => void disconnect(account)}
            >
              Disconnect
            </button>
          </div>
        </div>
      ))}

      <div className="row" style={{ justifyContent: 'flex-start', gap: 10, marginTop: 12 }}>
        <button disabled={busy !== null} onClick={() => void connect('google')}>
          Connect Gmail
        </button>
        <button disabled={busy !== null} onClick={() => void connect('microsoft')}>
          Connect Outlook
        </button>
      </div>
    </section>
  );
}

function HealthBadge({ health }: { health: ConnectedAccount['health'] }) {
  if (health.state === 'healthy') return <span className="badge ok">Connected</span>;

  if (health.state === 'degraded') {
    // Push could not be established. Mail arrives on a two-minute poll instead,
    // which is worth saying and not worth a warning colour that competes with
    // the one that means "act now".
    return <span className="badge warn">Checking every 2 min</span>;
  }

  return <span className="badge bad">Reconnect needed</span>;
}
