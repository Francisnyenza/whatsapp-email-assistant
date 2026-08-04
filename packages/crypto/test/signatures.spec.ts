import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyMetaSignature,
  verifyStripeSignature,
  verifyGraphClientState,
  signPayload,
  verifyPayloadSignature,
  safeCompare,
} from '../src/index.js';

/**
 * Webhook endpoints are public URLs that cause us to read mailboxes and send
 * messages. These tests exist to make sure verification never falls open.
 */

const APP_SECRET = 'meta-app-secret-value';

function metaSignature(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('Meta webhook signatures', () => {
  const body = Buffer.from(JSON.stringify({ entry: [{ id: '123' }] }));

  it('accepts a correctly signed body', () => {
    expect(verifyMetaSignature(body, metaSignature(body), APP_SECRET)).toBe(true);
  });

  it('rejects a body modified after signing', () => {
    const signature = metaSignature(body);
    const tampered = Buffer.from(JSON.stringify({ entry: [{ id: '999' }] }));
    expect(verifyMetaSignature(tampered, signature, APP_SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyMetaSignature(body, metaSignature(body, 'wrong-secret'), APP_SECRET)).toBe(false);
  });

  describe('never falls open', () => {
    // Each of these has been a real vulnerability somewhere: a missing header
    // treated as "no signature to check", so the request is allowed through.
    const badHeaders: Array<[string, string | undefined]> = [
      ['missing header', undefined],
      ['empty header', ''],
      ['no algorithm prefix', createHmac('sha256', APP_SECRET).update(body).digest('hex')],
      ['wrong algorithm', `sha1=${createHmac('sha1', APP_SECRET).update(body).digest('hex')}`],
      ['algorithm only', 'sha256='],
      ['garbage', 'sha256=not-a-hex-digest'],
      ['null-ish', 'null'],
    ];

    for (const [label, header] of badHeaders) {
      it(`rejects ${label}`, () => {
        expect(verifyMetaSignature(body, header, APP_SECRET)).toBe(false);
      });
    }

    it('rejects when the app secret is not configured', () => {
      // Refusing every webhook is the correct failure mode for a missing secret.
      expect(verifyMetaSignature(body, metaSignature(body), '')).toBe(false);
    });
  });

  it('verifies against raw bytes, not a re-serialized object', () => {
    // Key order and whitespace change the bytes. Any handler that parses before
    // verifying will produce a different digest and reject valid requests — or,
    // worse, be written to verify the re-serialized form and accept invalid ones.
    // Indentation and \u escapes both survive a parse but not a re-serialize.
    const raw = Buffer.from('{\n  "name": "caf\\u00e9",\n  "id": 1\n}');
    const signature = metaSignature(raw);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))));

    expect(Buffer.compare(raw, reserialized)).not.toBe(0);
    expect(verifyMetaSignature(raw, signature, APP_SECRET)).toBe(true);
    expect(verifyMetaSignature(reserialized, signature, APP_SECRET)).toBe(false);
  });
});

describe('Stripe webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = Buffer.from('{"id":"evt_1","type":"invoice.paid"}');

  function stripeHeader(timestamp: number, signingSecret = secret, payload = body): string {
    const v1 = createHmac('sha256', signingSecret)
      .update(`${timestamp}.`)
      .update(payload)
      .digest('hex');
    return `t=${timestamp},v1=${v1}`;
  }

  it('accepts a fresh, correctly signed event', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyStripeSignature(body, stripeHeader(now), secret)).toBe(true);
  });

  it('rejects a replayed event outside the tolerance window', () => {
    // Without the timestamp check, a captured webhook could be replayed forever.
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(verifyStripeSignature(body, stripeHeader(old), secret)).toBe(false);
  });

  it('accepts an event inside the tolerance window', () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    expect(verifyStripeSignature(body, stripeHeader(recent), secret)).toBe(true);
  });

  it('rejects a future timestamp beyond tolerance', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(verifyStripeSignature(body, stripeHeader(future), secret)).toBe(false);
  });

  it('accepts any valid signature during a secret rotation', () => {
    const now = Math.floor(Date.now() / 1000);
    const oldSig = createHmac('sha256', 'whsec_old').update(`${now}.`).update(body).digest('hex');
    const newSig = createHmac('sha256', secret).update(`${now}.`).update(body).digest('hex');

    expect(verifyStripeSignature(body, `t=${now},v1=${oldSig},v1=${newSig}`, secret)).toBe(true);
  });

  it('rejects malformed headers', () => {
    const now = Math.floor(Date.now() / 1000);
    for (const header of [undefined, '', 't=', `t=${now}`, 'v1=abc', 't=notanumber,v1=abc']) {
      expect(verifyStripeSignature(body, header, secret), String(header)).toBe(false);
    }
  });
});

describe('Microsoft Graph clientState', () => {
  // Graph does not sign notifications — the echoed clientState is the entire
  // authentication, so it must be treated as a shared secret.
  it('accepts the exact value', () => {
    expect(verifyGraphClientState('s3cr3t-state', 's3cr3t-state')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const received of [undefined, '', 's3cr3t-stat', 's3cr3t-state ', 'S3CR3T-STATE']) {
      expect(verifyGraphClientState(received, 's3cr3t-state'), String(received)).toBe(false);
    }
  });

  it('rejects when nothing was configured', () => {
    expect(verifyGraphClientState('anything', '')).toBe(false);
  });
});

describe('internal payload signing', () => {
  it('round-trips', () => {
    const payload = 'oauth-state:user-1:1754300000';
    expect(verifyPayloadSignature(payload, signPayload(payload, 'secret'), 'secret')).toBe(true);
  });

  it('rejects a modified payload', () => {
    const signature = signPayload('user-1', 'secret');
    expect(verifyPayloadSignature('user-2', signature, 'secret')).toBe(false);
  });

  it('rejects a signature from a different secret', () => {
    expect(verifyPayloadSignature('user-1', signPayload('user-1', 'other'), 'secret')).toBe(false);
  });
});

describe('safeCompare', () => {
  it('compares equal strings', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
  });

  it('rejects differing strings, including differing lengths', () => {
    expect(safeCompare('abc123', 'abc124')).toBe(false);
    expect(safeCompare('abc', 'abcd')).toBe(false);
    expect(safeCompare('', 'a')).toBe(false);
  });

  it('handles empty and multibyte input without throwing', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('héllo', 'héllo')).toBe(true);
    expect(safeCompare('héllo', 'hello')).toBe(false);
  });
});
