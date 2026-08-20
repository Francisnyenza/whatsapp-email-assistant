import { describe, it, expect, vi } from 'vitest';
import { JOB, jobKey, type WhatsAppStatusUpdate } from '@wea/shared';
import { NotifyProcessor } from '../src/processors/notify.processor.js';

/**
 * What happens to a delivery receipt.
 *
 * Meta sends one for every outbound message — `sent`, `delivered`, `read`, or
 * `failed` — and the API enqueues each as `notify.retryDelivery`. The notify
 * processor's `switch` had no case for that name, so every receipt fell to the
 * `default:` that throws `Unknown notify job` as non-retryable. All four kinds
 * dead-lettered, the delivery columns stayed null, and `failed` — the only one
 * that changes an outcome — was discarded along with the rest.
 *
 * Nothing caught it because the producer and the consumer were tested
 * separately: the controller test asserted the job was enqueued under the right
 * name, and the processor test only ever passed it names the processor already
 * knew. Neither asked whether the name one side sends is a name the other side
 * handles, which is the entire question.
 */

function processor(overrides: { applyDeliveryReceipt?: unknown } = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const inbox = {
    applyDeliveryReceipt:
      overrides.applyDeliveryReceipt ??
      vi.fn(async () => ({ userId: 'u1', emailMessageId: 'm1', phoneNumber: '+254700000001' })),
  };

  const instance = new NotifyProcessor(
    { env: {} } as never,
    {} as never,
    inbox as never,
    {} as never,
    logger as never,
  );

  return { instance, inbox, logger };
}

/** A receipt exactly as it comes off the queue: JSON, so no Date on it. */
function queued(over: Partial<WhatsAppStatusUpdate> = {}) {
  const update: WhatsAppStatusUpdate = {
    messageId: 'wamid.OUT.1',
    recipient: '254700000001',
    status: 'delivered',
    timestamp: new Date('2026-08-20T10:00:00.000Z'),
    ...over,
  };

  return {
    name: JOB.RETRY_DELIVERY,
    data: JSON.parse(JSON.stringify({ statusUpdate: update })) as never,
  } as never;
}

describe('a delivery receipt reaching the worker', () => {
  it('is handled rather than rejected as an unknown job', async () => {
    const { instance, inbox } = processor();

    await expect(instance.handle(queued())).resolves.toBeUndefined();
    expect(inbox.applyDeliveryReceipt).toHaveBeenCalledOnce();
  });

  it('arrives with a real Date, not the string JSON left behind', async () => {
    const { instance, inbox } = processor();

    await instance.handle(queued({ status: 'read' }));

    const [update] = (inbox.applyDeliveryReceipt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(update.timestamp).toBeInstanceOf(Date);
    expect(update.timestamp.getTime()).toBe(Date.parse('2026-08-20T10:00:00.000Z'));
  });

  it('says so loudly when WhatsApp did not deliver', async () => {
    // The send returned 200 and this is Meta contradicting it. Without a log at
    // warn, an undelivered email is indistinguishable from a delivered one.
    const { instance, logger } = processor();

    await instance.handle(
      queued({
        status: 'failed',
        error: { code: 131_047, title: 'Re-engagement message' },
      }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notify.delivery_failed', errorCode: 131_047 }),
      expect.any(String),
    );
  });

  it('does not resend by itself', async () => {
    // Tempting, and wrong. The usual failure is a closed 24-hour window or a
    // blocked number, where an immediate retry fails identically — and the
    // deferral path already holds mail until the window reopens.
    const { instance, logger } = processor();

    await instance.handle(queued({ status: 'failed' }));

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('passes over a receipt for a message it has no record of', async () => {
    const { instance } = processor({ applyDeliveryReceipt: vi.fn(async () => null) });

    await expect(instance.handle(queued())).resolves.toBeUndefined();
  });

  it('still refuses a job name nobody handles', async () => {
    // The `default:` is right; it was only ever reached by the wrong things.
    const { instance } = processor();

    await expect(
      instance.handle({ name: 'notify.somethingElse', data: {} } as never),
    ).rejects.toThrow(/Unknown notify job/);
  });
});

describe('the name the two sides agree on', () => {
  it('is the one the API enqueues', () => {
    // The producer builds `jobKey('wast', …)` for the id and JOB.RETRY_DELIVERY
    // for the name. Pinning the name here means a rename on either side breaks
    // a test rather than silently dead-lettering every receipt again.
    expect(JOB.RETRY_DELIVERY).toBe('notify.retryDelivery');
    expect(jobKey('wast', 'wamid.OUT.1', 'delivered')).toBe('wast~wamid.OUT.1~delivered');
  });
});
