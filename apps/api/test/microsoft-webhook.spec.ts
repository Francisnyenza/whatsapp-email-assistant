import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MicrosoftWebhookController } from '../src/webhooks/microsoft.controller.js';

/**
 * The Microsoft Graph notification endpoint.
 *
 * Two things carry the weight here. The **validation handshake**, without which
 * a subscription is never created at all — and the failure names the
 * notification URL rather than the handshake, so it costs whoever hits it first
 * a confusing hour. And **`clientState`**, which is the entire authentication:
 * Graph does not sign its notifications, so a shared secret compared badly is
 * the whole endpoint compromised.
 */

const SECRET = 'shared-secret-value';

function makeResponse() {
  const res: any = {
    statusCode: undefined as number | undefined,
    contentType: undefined as string | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(value: string) {
      res.contentType = value;
      return res;
    },
    send(body?: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const notification = (over: Record<string, unknown> = {}) => ({
  value: [
    {
      subscriptionId: 'sub-1',
      clientState: SECRET,
      changeType: 'created',
      resourceData: { id: 'AAMkmsg1' },
      ...over,
    },
  ],
});

describe('the Graph webhook', () => {
  let controller: MicrosoftWebhookController;
  let enqueue: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let logger: any;

  beforeEach(() => {
    enqueue = vi.fn().mockResolvedValue(undefined);
    findFirst = vi.fn().mockResolvedValue({ id: 'account-1', userId: 'user-1' });
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    controller = new MicrosoftWebhookController(
      { env: { MICROSOFT_WEBHOOK_CLIENT_STATE: SECRET } } as never,
      { enqueue } as never,
      { emailAccount: { findFirst } } as never,
      logger,
    );
  });

  const receive = (body: unknown, validationToken?: string) => {
    const res = makeResponse();
    return controller.receive({ body } as never, res, validationToken).then(() => res);
  };

  describe('the validation handshake', () => {
    it('echoes the token as plain text with a 200', async () => {
      // Graph POSTs this while creating a subscription and expects the exact
      // token back within ten seconds. Anything else and the subscription is
      // simply not created.
      const res = await receive({}, 'validation-token-abc');

      expect(res.statusCode).toBe(200);
      expect(res.contentType).toBe('text/plain');
      expect(res.body).toBe('validation-token-abc');
    });

    it('answers it before any authentication, because there is none yet', async () => {
      // It arrives before the subscription exists, so there is no clientState to
      // compare against. Echoing proves we control the URL, which is all Graph
      // is asking.
      const res = await receive({ value: [{ clientState: 'wrong' }] }, 'validation-token-abc');

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('validation-token-abc');
    });

    it('does no work and enqueues nothing', async () => {
      await receive({}, 'validation-token-abc');

      expect(enqueue).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    });
  });

  describe('authentication', () => {
    it('accepts a notification carrying the right client state', async () => {
      const res = await receive(notification());

      expect(res.statusCode).toBe(202);
      expect(enqueue).toHaveBeenCalled();
    });

    it('rejects a wrong client state and does no work', async () => {
      // Graph does not sign its notifications. This secret is the whole of the
      // authentication.
      const res = await receive(notification({ clientState: 'forged' }));

      expect(res.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('rejects one with no client state at all', async () => {
      const res = await receive(notification({ clientState: undefined }));
      expect(res.statusCode).toBe(401);
    });

    it('rejects a client state of the wrong length without throwing', async () => {
      // `timingSafeEqual` throws on a length mismatch, which would turn a
      // forgery attempt into a 500 and leak the length by the difference.
      const res = await receive(notification({ clientState: 'short' }));

      expect(res.statusCode).toBe(401);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('refuses everything when no secret is configured', async () => {
      // Accepting unverified notifications would be worse than delivering none.
      const unconfigured = new MicrosoftWebhookController(
        { env: {} } as never,
        { enqueue } as never,
        { emailAccount: { findFirst } } as never,
        logger,
      );
      const res = makeResponse();

      await unconfigured.receive({ body: notification() } as never, res, undefined);

      expect(res.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('does not let one valid entry authenticate a whole batch', async () => {
      // Graph batches, and a batch can legitimately span mailboxes — so every
      // entry is checked rather than the first.
      const res = await receive({
        value: [
          { subscriptionId: 'sub-1', clientState: SECRET, resourceData: { id: 'm1' } },
          { subscriptionId: 'sub-evil', clientState: 'forged', resourceData: { id: 'm2' } },
        ],
      });

      expect(res.statusCode).toBe(202);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0]![2]).toMatchObject({ accountId: 'account-1' });
      expect(findFirst).toHaveBeenCalledTimes(1);
    });
  });

  describe('routing', () => {
    it('finds the mailbox by subscription id, not by address', async () => {
      // A notification names a subscription and never a user, which is why the
      // subscription id is stored on the account at all.
      await receive(notification());

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { watchSubscriptionId: 'sub-1' } }),
      );
    });

    it('carries no cursor, because a Graph notification has none', async () => {
      // It says only that something changed. Ingest resumes from the delta link
      // we stored, which is the only correct place.
      await receive(notification());

      expect(enqueue.mock.calls[0]![2]).toMatchObject({
        userId: 'user-1',
        accountId: 'account-1',
        cursor: '',
        providerMessageId: 'AAMkmsg1',
      });
    });

    it('collapses a burst into one sync per account', async () => {
      // Graph sends one notification per message, so twenty arriving emails is
      // twenty notifications — and one delta walk catches all of them.
      await receive(notification());
      await receive(notification({ resourceData: { id: 'AAMkmsg2' } }));

      const [first, second] = enqueue.mock.calls.map((c) => c[3].jobId);
      expect(first).toBe(second);
    });

    it('drops a notification for a subscription we no longer hold', async () => {
      // Usually a disconnected account whose subscription has not lapsed yet.
      findFirst.mockResolvedValue(null);

      const res = await receive(notification());

      expect(res.statusCode).toBe(202);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('still acknowledges when enqueueing fails', async () => {
      // A bug on our side must not make Graph redeliver forever — it drops a
      // subscription whose endpoint keeps failing.
      enqueue.mockRejectedValue(new Error('redis down'));

      const res = await receive(notification());

      expect(res.statusCode).toBe(202);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('malformed bodies', () => {
    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['an empty object', {}],
      ['no value array', { value: 'not-an-array' }],
      ['entries that are not objects', { value: [null, 'x', 3] }],
      ['an empty batch', { value: [] }],
    ])('rejects %s rather than throwing', async (_label, body) => {
      const res = await receive(body);

      expect(res.statusCode).toBe(401);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
