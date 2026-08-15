'use client';

import { useCallback, useEffect, useState } from 'react';
import { endpoints, type PhoneStatus } from '@/lib/api';

/**
 * Linking a WhatsApp number.
 *
 * The flow runs *inbound* and the screen has to explain why, because "send us
 * this code" is not what anyone expects. We cannot message a number that has
 * never messaged us — Meta's 24-hour window — so a code sent outbound would need
 * an approved template. Having the user send it proves possession just as well
 * and opens the window at the same moment, which is the window the very first
 * notification needs.
 *
 * Until this is done, nothing is delivered anywhere. That is why it sits above
 * the mailbox list rather than below it.
 */
export function PhoneCard() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [code, setCode] = useState<{ code: string; sendTo: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    endpoints
      .phone()
      .then(setStatus)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  // While a code is outstanding, the page polls — the user is about to leave for
  // WhatsApp and come back, and making them refresh to find out whether it
  // worked is the kind of small friction that makes a setup flow feel broken.
  useEffect(() => {
    if (!code || status?.verified) return;
    const timer = setInterval(load, 4_000);
    return () => clearInterval(timer);
  }, [code, status?.verified, load]);

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const issued = await endpoints.startPhoneVerification();
      setCode({ code: issued.code, sendTo: issued.sendTo });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start verification.');
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!window.confirm('Stop sending your email to this number?')) return;

    setBusy(true);
    try {
      await endpoints.unlinkPhone();
      setCode(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink that number.');
    } finally {
      setBusy(false);
    }
  }

  if (status === null) return <p>Loading…</p>;

  if (status.verified) {
    return (
      <section>
        <h2>WhatsApp</h2>
        <div className="card row">
          <div>
            <strong>{status.phoneNumber}</strong>
            <div className="muted">Your email arrives here.</div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <span className="badge ok">Verified</span>
            <button className="danger" disabled={busy} onClick={() => void unlink()}>
              Unlink
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2>WhatsApp</h2>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          Nothing is delivered until a number is verified. Connect one and your email starts
          arriving there.
        </p>

        {error ? <p className="error">{error}</p> : null}

        {code ? (
          <>
            <p style={{ marginBottom: 8 }}>
              Send this code to <strong>{code.sendTo ?? 'our WhatsApp number'}</strong> from the
              phone you want to use:
            </p>
            <p className="code">{code.code}</p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Sending it from that phone is what proves it is yours. This page updates on its own
              once it arrives. The code expires in ten minutes.
            </p>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {busy ? 'Getting a code…' : 'Verify a number'}
          </button>
        )}
      </div>
    </section>
  );
}
