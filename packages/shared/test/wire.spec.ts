import { describe, it, expect } from 'vitest';
import { reviveDate, reviveInboundMessage, reviveStatusUpdate } from '../src/utils/wire.js';
import type { InboundWhatsAppMessage, WhatsAppStatusUpdate } from '../src/types/whatsapp.js';
import type { Wire } from '../src/utils/wire.js';

/**
 * What survives a queue.
 *
 * A BullMQ payload is JSON, and JSON has no `Date`. The inbound handler was
 * written as if it did — `job.data.payload as InboundWhatsAppMessage`, an
 * assertion the compiler cannot check — so `timestamp` arrived as a string and
 * the first line to treat it as a date threw `at.getTime is not a function`.
 *
 * Every existing test built the message object in memory and handed it straight
 * to the handler, which is why ~1,900 of them agreed the code was fine: they
 * never put it through the transport that breaks it. So the tests that matter
 * here are the ones that actually round-trip through `JSON.parse(JSON.stringify(…))`
 * rather than asserting on a hand-written literal.
 */

/** The transport, spelled out, because it is the thing under test. */
function throughAQueue<T>(value: T): Wire<T> {
  return JSON.parse(JSON.stringify(value)) as Wire<T>;
}

function inbound(overrides: Partial<InboundWhatsAppMessage> = {}): InboundWhatsAppMessage {
  return {
    id: 'wamid.HBgLMTU1NTAxMDAwMDAVAgASGBQ',
    from: '15550100000',
    timestamp: new Date('2026-08-20T09:15:00.000Z'),
    type: 'text',
    text: 'archive it',
    ...overrides,
  };
}

describe('an inbound message through a queue', () => {
  it('comes back with a timestamp you can call getTime on', () => {
    // The regression, stated as plainly as it can be. Without the revive step
    // this expression is `'2026-08-20T09:15:00.000Z'.getTime()`.
    const revived = reviveInboundMessage(throughAQueue(inbound()));

    expect(revived.timestamp).toBeInstanceOf(Date);
    expect(revived.timestamp.getTime()).toBe(Date.parse('2026-08-20T09:15:00.000Z'));
  });

  it('is otherwise unchanged', () => {
    const original = inbound({
      context: { id: 'wamid.PARENT', from: '15550100000' },
      media: { id: 'media-1', mimeType: 'audio/ogg', sha256: 'abc', voice: true },
    });

    const revived = reviveInboundMessage(throughAQueue(original));

    expect(revived).toEqual(original);
  });

  it('survives a payload whose timestamp is missing entirely', () => {
    // An older build's job, or a hand-injected replay. Losing a real customer
    // message over its least important field would be the wrong trade, so this
    // falls back rather than throwing into the dead-letter queue.
    const broken = { ...throughAQueue(inbound()), timestamp: undefined as unknown as string };

    const revived = reviveInboundMessage(broken);

    expect(revived.timestamp).toBeInstanceOf(Date);
    expect(revived.id).toBe('wamid.HBgLMTU1NTAxMDAwMDAVAgASGBQ');
  });
});

describe('a delivery receipt through a queue', () => {
  it('comes back with a real date', () => {
    const status: WhatsAppStatusUpdate = {
      messageId: 'wamid.OUT',
      recipient: '15550100000',
      status: 'delivered',
      timestamp: new Date('2026-08-20T09:16:30.000Z'),
    };

    const revived = reviveStatusUpdate(throughAQueue(status));

    expect(revived.timestamp.getTime()).toBe(Date.parse('2026-08-20T09:16:30.000Z'));
    expect(revived.status).toBe('delivered');
  });

  it('keeps the error, which is the only part anyone acts on', () => {
    const status: WhatsAppStatusUpdate = {
      messageId: 'wamid.OUT',
      recipient: '15550100000',
      status: 'failed',
      timestamp: new Date('2026-08-20T09:16:30.000Z'),
      error: { code: 131_047, title: 'Re-engagement message', details: 'outside the window' },
    };

    expect(reviveStatusUpdate(throughAQueue(status)).error).toEqual(status.error);
  });
});

describe('reviving a single date', () => {
  it('takes an ISO string', () => {
    expect(reviveDate('2026-08-20T09:15:00.000Z').toISOString()).toBe('2026-08-20T09:15:00.000Z');
  });

  it('takes epoch milliseconds, since not every producer sends ISO', () => {
    expect(reviveDate(1_755_681_300_000).getTime()).toBe(1_755_681_300_000);
  });

  it('passes a Date straight through', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(reviveDate(now)).toBe(now);
  });

  it('falls back on nonsense rather than producing an Invalid Date', () => {
    // An `Invalid Date` is the worst outcome available: it is an instance of
    // Date, it has getTime, and it poisons every comparison downstream while
    // passing any `instanceof` guard written to catch this class of bug.
    const fallback = new Date('2026-06-01T00:00:00.000Z');

    expect(reviveDate('not a date', fallback)).toBe(fallback);
    expect(reviveDate(null, fallback)).toBe(fallback);
    expect(reviveDate({}, fallback)).toBe(fallback);
    expect(reviveDate(new Date('nope'), fallback)).toBe(fallback);
  });

  it('defaults to now, which is off by the queue latency at worst', () => {
    const before = Date.now();

    expect(reviveDate(undefined).getTime()).toBeGreaterThanOrEqual(before);
  });
});
