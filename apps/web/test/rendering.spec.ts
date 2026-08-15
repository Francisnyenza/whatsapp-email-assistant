import { describe, it, expect } from 'vitest';
import { dynamic } from '../src/app/layout';

/**
 * One line of route configuration, pinned because removing it breaks the CSP
 * silently and only in production.
 *
 * A statically prerendered route has its HTML written at build time, before any
 * request exists and therefore before any nonce does. Next then emits every
 * `<script>` without one, and a `script-src` carrying a nonce alongside
 * `'strict-dynamic'` refuses all of them — the host allowlist that would
 * otherwise have saved them is deliberately inert once `'strict-dynamic'` is
 * present. The page is blank.
 *
 * Measured rather than assumed: served from a production build, the route
 * without this line emitted twelve script tags and nonced none of them; with
 * it, every tag carried the nonce from that request's own header.
 *
 * Dev never prerenders, so nothing about this is visible until deploy.
 */

describe('the root layout', () => {
  it('renders per request, which is what makes the CSP nonce possible', () => {
    expect(dynamic).toBe('force-dynamic');
  });
});
