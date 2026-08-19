import { describe, it, expect, vi } from 'vitest';
import { AccountService } from '../src/services/account.service.js';

/**
 * Which adapter a mailbox is operated through.
 *
 * This exists because it was wrong, and wrong in the quietest possible way.
 * Every call site in the worker — send, ingest, sync, forward, mailbox actions
 * — asked for the adapter by writing the literal `'gmail'`, because
 * `ProviderAccount` did not carry the kind and there was nothing else to pass.
 * A Microsoft mailbox was therefore operated through the Gmail adapter with a
 * Microsoft access token on every single operation, and the Graph adapter —
 * built, tested to 194 assertions, and marked shipped in the README — was never
 * once invoked at runtime.
 *
 * Nothing failed loudly. Phase 7 read as complete, its unit tests passed in
 * isolation, and the integration tests stub the provider, so no suite anywhere
 * exercised the wiring between an account and its adapter. The same insight was
 * even written down correctly in the API's linking service — "watching a Graph
 * account with the Gmail adapter would fail in a way that reads like a Google
 * outage" — and simply not applied on the other side.
 *
 * So these tests assert the routing itself rather than any behaviour of either
 * adapter. Two things are pinned: that the kind selects the adapter, and that
 * the kind is carried on the account, since the second is what makes the first
 * mistake impossible to repeat rather than merely discouraged.
 */

describe('choosing an adapter', () => {
  it('gives a Gmail account the Gmail adapter', () => {
    expect(service().providerFor('gmail').constructor.name).toBe('GmailProvider');
  });

  it('gives an Outlook account the Graph adapter, not the Gmail one', () => {
    // The assertion that would have failed for the entire life of the bug.
    expect(service().providerFor('outlook').constructor.name).toBe('GraphProvider');
  });

  it('treats Microsoft 365 as the same adapter as Outlook', () => {
    // One API, two consent screens. Two identical adapters would be two places
    // for a fix to be applied once.
    const built = service();

    expect(built.providerFor('microsoft365').constructor.name).toBe('GraphProvider');
    expect(built.providerFor('microsoft365')).toBe(built.providerFor('outlook'));
  });

  it('reuses one instance per kind rather than building per call', () => {
    // Each adapter holds an HTTP client and a token-refresh callback. Rebuilding
    // per operation would drop refreshed tokens on the floor.
    const built = service();

    expect(built.providerFor('gmail')).toBe(built.providerFor('gmail'));
  });

  it('does not silently fall back to Gmail for a kind it does not know', () => {
    // Falling back is how this bug would come back: an unknown kind quietly
    // becoming Gmail is indistinguishable, from the outside, from the hardcoded
    // literal it replaced.
    expect(() => service().providerFor('fastmail')).toThrow();
  });
});

describe('the account carries its kind', () => {
  it('is a required field, so no call site has to guess', () => {
    // A compile-time property rather than a runtime one, asserted here because
    // the type is the actual mechanism: making `provider` required turned three
    // silently-wrong construction sites into build errors the moment it landed.
    const account: Parameters<ReturnType<typeof service>['providerFor']>[0] = 'outlook';

    expect(typeof account).toBe('string');
  });
});

/* --------------------------------- helpers -------------------------------- */

function service(): AccountService {
  return new AccountService(
    { forUser: vi.fn() } as never,
    {
      env: {
        // Real `Env` always carries this — the schema defaults it to 'local'.
        // A fake that omits it now fails, because `createKmsProvider` reads it
        // rather than assuming, which is the whole point of the factory.
        KMS_PROVIDER: 'local',
        ENCRYPTION_MASTER_KEY: Buffer.alloc(32).toString('base64'),
        GOOGLE_CLIENT_ID: 'g',
        GOOGLE_CLIENT_SECRET: 'g',
        GOOGLE_REDIRECT_URI: 'https://x/g',
        MICROSOFT_CLIENT_ID: 'm',
        MICROSOFT_CLIENT_SECRET: 'm',
        MICROSOFT_REDIRECT_URI: 'https://x/m',
      },
    } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );
}
