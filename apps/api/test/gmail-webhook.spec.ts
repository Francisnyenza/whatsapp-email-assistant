import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseGmailPush } from '../src/webhooks/pubsub-envelope.js';
import { GmailWebhookController } from '../src/webhooks/gmail.controller.js';

/**
 * The Gmail push endpoint.
 *
 * Without token verification this is an unauthenticated way for anyone to make
 * us hammer the Gmail API on behalf of arbitrary mailboxes. Everything below is
 * about that, and about never letting Google redeliver something we cannot
 * process.
 */

function pushEnvelope(payload: unknown, messageId = 'pubsub-1') {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      messageId,
      publishTime: '2026-08-04T12:00:00Z',
    },
    subscription: 'projects/p/subscriptions/s',
  };
}

describe('parsing the push envelope', () => {
  it('unwraps both layers', () => {
    // Google wraps the notification twice: a Pub/Sub envelope whose data field
    // is base64 holding the Gmail payload.
    const parsed = parseGmailPush(
      pushEnvelope({ emailAddress: 'Sarah@Acme.com', historyId: 987654 }),
    );

    expect(parsed).toEqual({
      emailAddress: 'sarah@acme.com',
      historyId: '987654',
      messageId: 'pubsub-1',
    });
  });

  it('lower-cases the address so it matches how routes are stored', () => {
    const parsed = parseGmailPush(
      pushEnvelope({ emailAddress: 'MiXeD@Example.COM', historyId: 1 }),
    );
    expect(parsed!.emailAddress).toBe('mixed@example.com');
  });

  it('carries historyId as a string, whichever way Gmail sends it', () => {
    // JSON gives a number; the Gmail API wants a string back.
    expect(
      parseGmailPush(pushEnvelope({ emailAddress: 'a@b.com', historyId: 42 }))!.historyId,
    ).toBe('42');
    expect(
      parseGmailPush(pushEnvelope({ emailAddress: 'a@b.com', historyId: '42' }))!.historyId,
    ).toBe('42');
  });

  describe('returns null rather than throwing', () => {
    // A push we cannot understand must be acknowledged and dropped. Returning a
    // non-2xx would have Google redeliver it forever.
    const bad: Array<[string, unknown]> = [
      ['null', null],
      ['a string', 'nope'],
      ['empty object', {}],
      ['no data field', { message: { messageId: 'x' } }],
      ['data that is not base64 JSON', { message: { data: '!!!not-base64!!!' } }],
      [
        'valid base64, invalid JSON',
        { message: { data: Buffer.from('{oops').toString('base64') } },
      ],
      ['missing emailAddress', pushEnvelope({ historyId: 1 })],
      ['missing historyId', pushEnvelope({ emailAddress: 'a@b.com' })],
      ['address that is not an address', pushEnvelope({ emailAddress: 'nope', historyId: 1 })],
      ['non-numeric historyId', pushEnvelope({ emailAddress: 'a@b.com', historyId: 'abc' })],
    ];

    for (const [label, body] of bad) {
      it(`for ${label}`, () => {
        expect(parseGmailPush(body)).toBeNull();
      });
    }
  });
});

describe('the endpoint', () => {
  let controller: GmailWebhookController;
  let enqueue: ReturnType<typeof vi.fn>;
  let verify: ReturnType<typeof vi.fn>;
  let findRoute: ReturnType<typeof vi.fn>;
  let logger: any;

  function makeResponse() {
    const res: any = {
      statusCode: undefined as number | undefined,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      send() {
        return res;
      },
    };
    return res;
  }

  beforeEach(() => {
    enqueue = vi.fn().mockResolvedValue(undefined);
    verify = vi.fn().mockResolvedValue(true);
    findRoute = vi.fn().mockResolvedValue({ userId: 'user-1', accountId: 'account-1' });
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    controller = new GmailWebhookController(
      { env: {} } as never,
      { verify } as never,
      { enqueue } as never,
      { providerAccountRoute: { findUnique: findRoute } } as never,
      logger,
    );
  });

  const push = (body: unknown = pushEnvelope({ emailAddress: 'a@b.com', historyId: 5 })) =>
    controller.receive({ body } as never, makeResponse(), 'Bearer google-token');

  it('rejects a push with an invalid token and does no work', async () => {
    verify.mockResolvedValue(false);
    const res = makeResponse();

    await controller.receive({ body: {} } as never, res, 'Bearer forged');

    expect(res.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
    expect(findRoute).not.toHaveBeenCalled();
  });

  it('rejects a push with no token at all', async () => {
    verify.mockResolvedValue(false);
    const res = makeResponse();

    await controller.receive({ body: {} } as never, res, undefined);

    expect(res.statusCode).toBe(401);
  });

  it('enqueues ingest for the routed account', async () => {
    await push();

    expect(enqueue).toHaveBeenCalledWith(
      'ingest',
      'ingest.processChange',
      expect.objectContaining({ userId: 'user-1', accountId: 'account-1', cursor: '5' }),
      expect.objectContaining({ jobId: 'ingest~account-1~5' }),
    );
  });

  it('collapses repeated pushes for one mailbox into a single sync', async () => {
    // history.list catches everything since the stored cursor regardless of how
    // many pushes triggered it, so a burst should not become a burst of jobs.
    const body = pushEnvelope({ emailAddress: 'a@b.com', historyId: 5 });

    await push(body);
    await push(body);

    const jobIds = enqueue.mock.calls.map((call) => call[3].jobId);
    expect(new Set(jobIds).size).toBe(1);
  });

  it('acknowledges a push for a mailbox we no longer watch', async () => {
    // Usually a disconnected account whose Gmail watch has not lapsed yet.
    findRoute.mockResolvedValue(null);
    const res = makeResponse();

    await controller.receive(
      { body: pushEnvelope({ emailAddress: 'gone@b.com', historyId: 5 }) } as never,
      res,
      'Bearer google-token',
    );

    expect(res.statusCode).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acknowledges an authentic but unparseable push', async () => {
    const res = makeResponse();
    await controller.receive({ body: { garbage: true } } as never, res, 'Bearer google-token');

    expect(res.statusCode).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still acknowledges when enqueueing fails', async () => {
    // A failure on our side must not make Google redeliver forever.
    enqueue.mockRejectedValue(new Error('redis down'));
    const res = makeResponse();

    await controller.receive(
      { body: pushEnvelope({ emailAddress: 'a@b.com', historyId: 5 }) } as never,
      res,
      'Bearer google-token',
    );

    expect(res.statusCode).toBe(204);
    // But loudly, because this is mail the user will never hear about.
    expect(logger.error).toHaveBeenCalled();
  });

  it('acknowledges before doing any work', async () => {
    const order: string[] = [];
    enqueue.mockImplementation(async () => {
      order.push('enqueue');
    });

    const res = makeResponse();
    res.send = () => {
      order.push('respond');
      return res;
    };

    await controller.receive(
      { body: pushEnvelope({ emailAddress: 'a@b.com', historyId: 5 }) } as never,
      res,
      'Bearer google-token',
    );

    expect(order).toEqual(['respond', 'enqueue']);
  });

  it('looks the mailbox up by its lower-cased address', async () => {
    await push(pushEnvelope({ emailAddress: 'MiXeD@Example.com', historyId: 5 }));

    expect(findRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_providerAddress: { provider: 'gmail', providerAddress: 'mixed@example.com' },
        },
      }),
    );
  });
});
