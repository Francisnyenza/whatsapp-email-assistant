'use client';

import { SessionProvider, useSession } from '@/lib/session';
import { SignInForm } from './signin/form';
import { Accounts } from './accounts/accounts';
import { PhoneCard } from './accounts/phone';
import { SettingsForm } from './settings/form';

/**
 * One page.
 *
 * Everything this dashboard does — connect a mailbox, prove a phone number, set
 * when notifications arrive — is a thing someone does once during setup and then
 * never returns to. Splitting it across routes would add navigation to a task
 * that fits on a screen, and would hide from a new user how much is left to do.
 */
export default function Home() {
  return (
    <SessionProvider>
      <Dashboard />
    </SessionProvider>
  );
}

function Dashboard() {
  const session = useSession();

  if (session.status === 'loading') return <p>Loading…</p>;
  if (session.status === 'signed-out') return <SignInForm />;

  return (
    <>
      <header className="row" style={{ marginBottom: 28 }}>
        <div>
          <h1>Inbox on WhatsApp</h1>
          <p style={{ margin: 0 }}>{session.email}</p>
        </div>
        <button onClick={session.signOut}>Sign out</button>
      </header>

      {/*
        The order is the order someone has to do them in. A mailbox with no
        verified phone delivers nothing, so putting settings first would let
        someone tune notifications they will never receive.
      */}
      <PhoneCard />
      <Accounts />
      <SettingsForm />
    </>
  );
}
