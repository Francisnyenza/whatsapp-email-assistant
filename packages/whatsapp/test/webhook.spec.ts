import { describe, it, expect } from 'vitest';
import { parseWebhook, handleVerificationChallenge, webhookDedupeKey } from '../src/index.js';

/**
 * Webhook payloads come from a public endpoint. Every test here is about
 * behaving predictably on input we do not control.
 */

function envelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '10000000000',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001', phone_number_id: '9876' },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

describe('parsing inbound messages', () => {
  it('parses a text message', () => {
    const parsed = parseWebhook(
      envelope({
        contacts: [{ wa_id: '254712345678', profile: { name: 'Demo User' } }],
        messages: [
          {
            id: 'wamid.ABC',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'text',
            text: { body: 'Reply yes' },
          },
        ],
      }),
    );

    expect(parsed?.messages).toHaveLength(1);
    const message = parsed!.messages[0]!;
    expect(message.id).toBe('wamid.ABC');
    expect(message.type).toBe('text');
    expect(message.text).toBe('Reply yes');
    expect(message.timestamp.toISOString()).toBe('2026-08-04T13:20:00.000Z');
    expect(parsed?.contactNames.get('254712345678')).toBe('Demo User');
    expect(parsed?.phoneNumberId).toBe('9876');
  });

  it('preserves the reply context, which is how a reply finds its email', () => {
    // Rank 1 on the thread-resolution ladder (ADR 0003). Losing this field means
    // guessing which email a reply belongs to.
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.REPLY',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'text',
            text: { body: 'Friday works' },
            context: { id: 'wamid.ORIGINAL', from: '15550001' },
          },
        ],
      }),
    );

    expect(parsed?.messages[0]?.context?.id).toBe('wamid.ORIGINAL');
  });

  it('parses an interactive button reply', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.BTN',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'act:reply:msg-123', title: 'Reply' },
            },
          },
        ],
      }),
    );

    expect(parsed?.messages[0]?.interactive).toEqual({
      type: 'button_reply',
      id: 'act:reply:msg-123',
      title: 'Reply',
    });
  });

  it('parses a list selection', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.LIST',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: { id: 'act:open_thread:msg-9', title: 'Sarah Chen' },
            },
          },
        ],
      }),
    );

    expect(parsed?.messages[0]?.interactive?.type).toBe('list_reply');
    expect(parsed?.messages[0]?.interactive?.id).toBe('act:open_thread:msg-9');
  });

  it('parses a template quick-reply, whose payload lands in a different field', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.TPL',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'button',
            button: { payload: 'act:reply:msg-7', text: 'Read it' },
          },
        ],
      }),
    );

    expect(parsed?.messages[0]?.interactive?.id).toBe('act:reply:msg-7');
  });

  it('distinguishes a voice note from an audio file', () => {
    // A voice note becomes an email; a music file does not.
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.VOICE',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'audio',
            audio: {
              id: 'media-1',
              mime_type: 'audio/ogg; codecs=opus',
              sha256: 'abc',
              voice: true,
            },
          },
        ],
      }),
    );

    expect(parsed?.messages[0]?.media?.voice).toBe(true);
    expect(parsed?.messages[0]?.media?.mimeType).toBe('audio/ogg; codecs=opus');
  });

  it('parses a document with its filename and caption', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.DOC',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'document',
            document: {
              id: 'media-2',
              mime_type: 'application/pdf',
              sha256: 'def',
              filename: 'invoice.pdf',
              caption: 'Send this to accounts',
            },
          },
        ],
      }),
    );

    const message = parsed!.messages[0]!;
    expect(message.media?.filename).toBe('invoice.pdf');
    expect(message.text).toBe('Send this to accounts');
  });

  it('degrades an unknown message type instead of throwing', () => {
    // Meta ships new types without notice. A worker crash-looping on an
    // unrecognized reaction is worse than an unhandled one.
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.NEW',
            from: '254712345678',
            timestamp: '1785849600',
            type: 'some_future_type',
            some_future_type: { whatever: true },
          },
        ],
      }),
    );

    expect(parsed?.messages[0]?.type).toBe('unknown');
    expect(parsed?.messages[0]?.id).toBe('wamid.NEW');
  });

  it('handles several messages and entries in one delivery', () => {
    const parsed = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.1',
                    from: '254700000001',
                    timestamp: '1785849600',
                    type: 'text',
                    text: { body: 'one' },
                  },
                  {
                    id: 'wamid.2',
                    from: '254700000002',
                    timestamp: '1785849601',
                    type: 'text',
                    text: { body: 'two' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(parsed?.messages.map((m) => m.text)).toEqual(['one', 'two']);
  });
});

describe('parsing delivery statuses', () => {
  it('parses a delivered status', () => {
    const parsed = parseWebhook(
      envelope({
        statuses: [
          {
            id: 'wamid.SENT',
            recipient_id: '254712345678',
            status: 'delivered',
            timestamp: '1785849600',
            conversation: { id: 'conv-1', origin: { type: 'service' } },
          },
        ],
      }),
    );

    expect(parsed?.statuses[0]).toMatchObject({
      messageId: 'wamid.SENT',
      status: 'delivered',
      recipient: '254712345678',
    });
    expect(parsed?.statuses[0]?.conversation?.category).toBe('service');
  });

  it('parses a failure with its error detail', () => {
    const parsed = parseWebhook(
      envelope({
        statuses: [
          {
            id: 'wamid.FAIL',
            recipient_id: '254712345678',
            status: 'failed',
            timestamp: '1785849600',
            errors: [
              {
                code: 131047,
                title: 'Re-engagement message',
                error_data: { details: 'Outside the 24 hour window' },
              },
            ],
          },
        ],
      }),
    );

    expect(parsed?.statuses[0]?.error).toEqual({
      code: 131047,
      title: 'Re-engagement message',
      details: 'Outside the 24 hour window',
    });
  });

  it('maps an unrecognized status to sent rather than dropping it', () => {
    const parsed = parseWebhook(
      envelope({
        statuses: [
          {
            id: 'wamid.X',
            recipient_id: '254712345678',
            status: 'warning',
            timestamp: '1785849600',
          },
        ],
      }),
    );
    expect(parsed?.statuses[0]?.status).toBe('sent');
  });
});

describe('malformed and hostile payloads', () => {
  const rejected: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'not json'],
    ['an array', []],
    ['empty object', {}],
    ['wrong object type', { object: 'page', entry: [] }],
    ['entry not an array', { object: 'whatsapp_business_account', entry: 'nope' }],
    ['missing changes', { object: 'whatsapp_business_account', entry: [{ id: '1' }] }],
    [
      'message missing required fields',
      {
        object: 'whatsapp_business_account',
        entry: [
          { id: '1', changes: [{ field: 'messages', value: { messages: [{ type: 'text' }] } }] },
        ],
      },
    ],
  ];

  for (const [label, payload] of rejected) {
    it(`returns null for ${label}`, () => {
      // Null, not an exception: Meta retries on non-2xx, and retrying a payload
      // we can never parse is an infinite loop.
      expect(parseWebhook(payload)).toBeNull();
    });
  }

  it('tolerates an empty change with no messages or statuses', () => {
    const parsed = parseWebhook(envelope({}));
    expect(parsed?.messages).toEqual([]);
    expect(parsed?.statuses).toEqual([]);
  });

  it('does not trust a malformed timestamp', () => {
    const parsed = parseWebhook(
      envelope({
        messages: [
          {
            id: 'wamid.T',
            from: '254712345678',
            timestamp: 'not-a-number',
            type: 'text',
            text: { body: 'hi' },
          },
        ],
      }),
    );
    expect(parsed?.messages[0]?.timestamp).toBeInstanceOf(Date);
    expect(Number.isNaN(parsed!.messages[0]!.timestamp.getTime())).toBe(false);
  });
});

describe('verification handshake', () => {
  it('echoes the challenge when the token matches', () => {
    const query = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'secret',
      'hub.challenge': '12345',
    };
    expect(handleVerificationChallenge(query, 'secret')).toBe('12345');
  });

  it('refuses anything else', () => {
    const base = {
      'hub.mode': 'subscribe',
      'hub.verify_token': 'secret',
      'hub.challenge': '12345',
    };
    expect(
      handleVerificationChallenge({ ...base, 'hub.verify_token': 'wrong' }, 'secret'),
    ).toBeNull();
    expect(
      handleVerificationChallenge({ ...base, 'hub.mode': 'unsubscribe' }, 'secret'),
    ).toBeNull();
    expect(handleVerificationChallenge({}, 'secret')).toBeNull();
    // An unconfigured verify token must reject, not accept everything.
    expect(handleVerificationChallenge(base, '')).toBeNull();
  });
});

describe('de-duplication key', () => {
  it('is stable for identical bytes and differs otherwise', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    expect(webhookDedupeKey(body)).toBe(webhookDedupeKey(Buffer.from(body)));
    expect(webhookDedupeKey(body)).not.toBe(webhookDedupeKey(Buffer.from('{"other":1}')));
  });
});
