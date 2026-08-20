import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WhatsAppWebhookController } from '../src/webhooks/whatsapp.controller.js';

/**
 * The webhook is a public, unauthenticated URL that causes us to read mailboxes
 * and send messages on people's behalf. These tests are the contract for that
 * boundary.
 */

const APP_SECRET = 'meta-app-secret';
const VERIFY_TOKEN = 'verify-token';

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function envelope(messages: unknown[] = [], statuses: unknown[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { display_phone_number: '1555', phone_number_id: '99' },
              ...(messages.length ? { messages } : {}),
              ...(statuses.length ? { statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

const textMessage = {
  id: 'wamid.ABC',
  from: '254712345678',
  timestamp: '1785849600',
  type: 'text',
  text: { body: 'Reply yes' },
};

function makeResponse() {
  const res: any = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    contentType: undefined as string | undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(payload?: unknown) {
      res.body = payload;
      return res;
    },
    type(t: string) {
      res.contentType = t;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

describe('WhatsApp webhook', () => {
  let controller: WhatsAppWebhookController;
  let enqueue: ReturnType<typeof vi.fn>;
  let logger: any;

  beforeEach(() => {
    enqueue = vi.fn().mockResolvedValue(undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    controller = new WhatsAppWebhookController(
      {
        env: { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN },
      } as any,
      { enqueue } as any,
      logger,
    );
  });

  describe('verification handshake', () => {
    it('echoes the challenge as plain text when the token matches', () => {
      const res = makeResponse();
      controller.verify(
        { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '12345' },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('12345');
      // Meta rejects a JSON-wrapped challenge.
      expect(res.contentType).toBe('text/plain');
    });

    it('rejects a wrong or missing token', () => {
      for (const query of [
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' },
        { 'hub.mode': 'subscribe', 'hub.challenge': 'x' },
        {},
      ]) {
        const res = makeResponse();
        controller.verify(query as any, res);
        expect(res.statusCode).toBe(403);
      }
    });
  });

  describe('signature verification', () => {
    it('accepts a correctly signed payload and enqueues it', async () => {
      const body = envelope([textMessage]);
      const raw = Buffer.from(JSON.stringify(body));
      const res = makeResponse();

      await controller.receive({ rawBody: raw, body } as any, res, sign(raw));

      expect(res.statusCode).toBe(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
    });

    it('rejects an unsigned request without enqueueing anything', async () => {
      const body = envelope([textMessage]);
      const raw = Buffer.from(JSON.stringify(body));
      const res = makeResponse();

      await controller.receive({ rawBody: raw, body } as any, res, undefined);

      expect(res.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('rejects a signature computed with the wrong secret', async () => {
      const body = envelope([textMessage]);
      const raw = Buffer.from(JSON.stringify(body));
      const res = makeResponse();

      await controller.receive({ rawBody: raw, body } as any, res, sign(raw, 'attacker-secret'));

      expect(res.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('rejects a body altered after signing', async () => {
      const original = Buffer.from(JSON.stringify(envelope([textMessage])));
      const signature = sign(original);

      const tampered = envelope([{ ...textMessage, text: { body: 'delete everything' } }]);
      const res = makeResponse();

      await controller.receive(
        { rawBody: Buffer.from(JSON.stringify(tampered)), body: tampered } as any,
        res,
        signature,
      );

      expect(res.statusCode).toBe(401);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('fails closed when the raw body is unavailable', async () => {
      // If the parser is ever reconfigured and stops retaining raw bytes, there
      // is nothing to verify against — that must be a rejection, not a bypass.
      const body = envelope([textMessage]);
      const res = makeResponse();

      await controller.receive({ rawBody: undefined, body } as any, res, sign(Buffer.from('x')));

      expect(res.statusCode).toBe(400);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('reveals nothing in the rejection response', async () => {
      const raw = Buffer.from(JSON.stringify(envelope([textMessage])));
      const res = makeResponse();

      await controller.receive({ rawBody: raw, body: {} } as any, res, 'sha256=deadbeef');

      expect(res.statusCode).toBe(401);
      // An attacker probing the endpoint learns nothing about why it failed.
      expect(res.body).toBeUndefined();
    });
  });

  describe('acknowledgement behaviour', () => {
    it('returns 200 for an authentic but unparseable payload', async () => {
      // Already acknowledged, so Meta will not retry — correct, because
      // retrying something we can never parse is an infinite loop.
      const body = { object: 'page', entry: [] };
      const raw = Buffer.from(JSON.stringify(body));
      const res = makeResponse();

      await controller.receive({ rawBody: raw, body } as any, res, sign(raw));

      expect(res.statusCode).toBe(200);
      expect(enqueue).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('still returns 200 when enqueueing fails', async () => {
      // A failure on our side must not make Meta redeliver forever.
      enqueue.mockRejectedValue(new Error('redis down'));
      const body = envelope([textMessage]);
      const raw = Buffer.from(JSON.stringify(body));
      const res = makeResponse();

      await controller.receive({ rawBody: raw, body } as any, res, sign(raw));

      expect(res.statusCode).toBe(200);
      // But it is logged as an error — this is a dropped inbound message, which
      // the user experiences as being ignored.
      expect(logger.error).toHaveBeenCalled();
    });

    it('acknowledges before doing any work', async () => {
      // The response must not wait on the queue: Meta retries anything slow.
      const order: string[] = [];
      enqueue.mockImplementation(async () => {
        order.push('enqueue');
      });

      const body = envelope([textMessage]);
      const raw = Buffer.from(JSON.stringify(body));
      const res = makeResponse();
      res.send = () => {
        order.push('respond');
        return res;
      };

      await controller.receive({ rawBody: raw, body } as any, res, sign(raw));

      expect(order).toEqual(['respond', 'enqueue']);
    });
  });

  describe('idempotency', () => {
    it('keys each job on Meta’s message id', async () => {
      // Meta retries aggressively and occasionally duplicates on success. The
      // wamid as jobId makes a redelivery resolve to the same job.
      const body = envelope([textMessage]);
      const raw = Buffer.from(JSON.stringify(body));

      await controller.receive({ rawBody: raw, body } as any, makeResponse(), sign(raw));

      expect(enqueue).toHaveBeenCalledWith(
        'commands',
        'commands.handleInbound',
        expect.objectContaining({ whatsappMessageId: 'wamid.ABC', phoneNumber: '254712345678' }),
        { jobId: 'wa~wamid.ABC' },
      );
    });

    it('keys status updates on message id and status', async () => {
      // The same message legitimately produces sent, delivered and read, so the
      // status has to be part of the key or two of the three get dropped.
      const status = {
        id: 'wamid.SENT',
        recipient_id: '254712345678',
        status: 'delivered',
        timestamp: '1785849600',
      };
      const body = envelope([], [status]);
      const raw = Buffer.from(JSON.stringify(body));

      await controller.receive({ rawBody: raw, body } as any, makeResponse(), sign(raw));

      expect(enqueue).toHaveBeenCalledWith('notify', 'notify.retryDelivery', expect.anything(), {
        jobId: 'wast~wamid.SENT~delivered',
      });
    });

    it('enqueues every message in a batched delivery', async () => {
      const body = envelope([
        textMessage,
        { ...textMessage, id: 'wamid.DEF', text: { body: 'archive' } },
      ]);
      const raw = Buffer.from(JSON.stringify(body));

      await controller.receive({ rawBody: raw, body } as any, makeResponse(), sign(raw));

      expect(enqueue).toHaveBeenCalledTimes(2);
    });
  });
});
