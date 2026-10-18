import { describe, it, expect, afterEach } from 'vitest';
import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from 'node:net';
import { widenConnectAttemptTimeout, CONNECT_ATTEMPT_TIMEOUT_MS } from '../src/utils/network.js';

/**
 * Node's 250 ms per-address budget is what turned a working IPv4 route into
 * ETIMEDOUT on a real install. These pin that the boot hook raises it and never
 * lowers a larger value someone set on purpose (`--network-family-autoselection-attempt-timeout`).
 */
describe('the connect attempt timeout', () => {
  const original = getDefaultAutoSelectFamilyAttemptTimeout();
  afterEach(() => setDefaultAutoSelectFamilyAttemptTimeout(original));

  it('is raised from Node’s default', () => {
    setDefaultAutoSelectFamilyAttemptTimeout(250);
    widenConnectAttemptTimeout();
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
  });

  it('is left alone when it is already longer', () => {
    setDefaultAutoSelectFamilyAttemptTimeout(5_000);
    widenConnectAttemptTimeout();
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5_000);
  });
});
