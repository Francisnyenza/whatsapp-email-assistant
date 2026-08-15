import { NextResponse, type NextRequest } from 'next/server';

/**
 * The Content-Security-Policy, issued per request with a fresh nonce.
 *
 * This is the other half of a decision made in `lib/api.ts`. Keeping the access
 * token in memory rather than `localStorage` limits what an XSS can *keep* — it
 * dies with the tab instead of being exfiltrated once and reused forever. It
 * does nothing about what an XSS can *do* while the tab is open, which is
 * everything the user can do. A nonce-based `script-src` is the control that
 * addresses that half: injected markup carries no nonce, so it never executes.
 *
 * It has to live in middleware rather than in `next.config.mjs`, because a
 * nonce is only worth having if it is unguessable and therefore per-request,
 * and static headers cannot be. Next reads the nonce back out of the CSP on the
 * *request* headers and stamps it onto its own hydration scripts, which is why
 * the policy is set on both the request and the response below — setting it
 * only on the response produces a page whose own scripts are blocked.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = policy(nonce);

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);

  return response;
}

function policy(nonce: string): string {
  const dev = process.env.NODE_ENV !== 'production';

  // The API is a different origin, so it has to be named. Anything not named
  // here cannot be reached by script — which is what makes an injected
  // exfiltration request fail rather than quietly succeed.
  const api = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:3001';
  const apiOrigin = originOf(api);

  return [
    `default-src 'self'`,
    // `strict-dynamic` lets Next's nonced loader pull in the chunks it needs
    // without us enumerating them, and makes the host allowlist inert — which
    // is the point, since host allowlists are routinely bypassable. `unsafe-eval`
    // is dev-only: the HMR runtime needs it, production does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Inline styles are permitted knowingly. Next injects critical CSS inline
    // and does not nonce all of it, and the residual risk is not comparable:
    // CSS cannot execute, and script-src is where session theft actually lives.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self' ${apiOrigin}${dev ? ' ws: wss:' : ''}`,
    // Clickjacking, belt and braces with the X-Frame-Options in next.config —
    // that one is for browsers too old to honour this.
    `frame-ancestors 'none'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    // Without these, an injected <base> or a rewritten form action turns a
    // markup injection into credential theft with no script involved at all.
    `base-uri 'none'`,
    `form-action 'self'`,
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/**
 * The origin of the API, or a token that matches nothing.
 *
 * A malformed base URL must not degrade into a wildcard. Failing closed here
 * means a misconfigured deploy shows a dashboard that cannot load data — loud,
 * and fixed in minutes — rather than one with a policy that permits everything.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "'none'";
  }
}

export const config = {
  // Everything except Next's own static output and the favicon. Static assets
  // are served without markup, so a policy on them buys nothing and costs a
  // middleware invocation each.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
