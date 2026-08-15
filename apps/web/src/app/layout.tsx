import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Inbox on WhatsApp',
  description: 'Read and answer your email from WhatsApp.',
};

/**
 * Rendered per request, because the CSP nonce cannot exist otherwise.
 *
 * A statically prerendered page has its HTML written at build time, long before
 * any request has a nonce — so Next emits every `<script>` unnonced, and a
 * `script-src` carrying a nonce with `'strict-dynamic'` blocks all of them. The
 * result is a blank page, and it is blank only in production, because dev never
 * prerenders. This line is the difference between a policy that protects the
 * dashboard and one that deletes it.
 *
 * Nothing is lost. Every route here is an authenticated view of data the client
 * fetches after mount; there was never any static HTML worth caching.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
