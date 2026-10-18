import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net';

/**
 * How long one address gets to connect before Node moves to the next.
 *
 * Node's happy-eyeballs default is 250 ms per address, and it abandons an
 * attempt when the timer fires rather than racing it against the next one. On a
 * network with no IPv6 route and ~300 ms to Google — an ordinary mobile
 * connection in East Africa — the IPv6 address fails, the IPv4 one is cut off
 * before its handshake completes, and the call surfaces as ETIMEDOUT. That is
 * how connecting Gmail failed on the first real install, while curl reached the
 * same endpoint over IPv4 in under a second.
 *
 * Two seconds still falls through quickly when an address is refused outright,
 * which is the common IPv6 failure, and only costs anything when one hangs.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;

/** Applies {@link CONNECT_ATTEMPT_TIMEOUT_MS} process-wide. Call once, at boot. */
export function widenConnectAttemptTimeout(): void {
  if (getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_TIMEOUT_MS) {
    setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
  }
}
