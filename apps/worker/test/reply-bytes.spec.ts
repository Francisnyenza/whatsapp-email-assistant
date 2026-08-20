import { describe, it, expect, vi, beforeEach } from 'vitest';
import { composeMime } from '@wea/mail';
import { SendProcessor, composeReplyFrom } from '../src/processors/send.processor.js';

/**
 * What the recipient actually receives.
 *
 * The product's headline promise is one sentence: *the recipient gets a normal
 * email and never knows it was answered from WhatsApp*. Two suites each check
 * half of it and neither checks the promise.
 *
 * `mime-builder.spec.ts` renders real RFC 822 bytes and asserts they carry
 * nothing extra — but from a hand-written `ComposeInput`. `send-forward.spec.ts`
 * runs the real send path against a real draft — but stops at a stubbed
 * `provider.send`, asserting on the `OutboundMessage` object and never
 * rendering it. So "does the thing the worker builds render into an email with
 * no trace of WhatsApp in it" is a question that falls exactly between them.
 *
 * That gap is the shape of both bugs found this week: a producer and a consumer
 * tested separately, agreeing with each other, and wrong about the seam. Here
 * the provider stub renders with the same `composeMime` the Gmail and Graph
 * adapters call, so the assertions are against bytes rather than intentions.
 */

/** Everything the user's mailbox holds about the message being answered. */
const ORIGINAL = {
  messageIdHeader: '<CAF=q3@mail.acme.com>',
  references: ['<root@acme.com>', '<CAF=q2@mail.acme.com>'],
  subject: 'Q3 report',
  from: { name: 'Sarah Chen', address: 'sarah.chen@acme.com' },
  to: [{ name: 'Me', address: 'me@example.com' }],
  cc: [{ name: 'Tom Riley', address: 'tom@acme.com' }],
};

const SELF = 'me@example.com';
const PHONE = '+254712345678';
const REPLY_TEXT = 'On it — sending the numbers this afternoon.';

/**
 * The send path, ending in real MIME.
 *
 * The provider stub does what `GmailProvider.send` does with the message it is
 * handed: builds the same `composeMime` input from it. That is the step the
 * existing tests skip, and the only one that produces something a recipient
 * would see.
 */
function harness(over: { replyAll?: boolean; bodyText?: string } = {}) {
  const rendered: { raw?: string } = {};

  const headers = composeReplyFrom(ORIGINAL, SELF, over.replyAll ?? false);

  const claimed = {
    id: 'draft-1',
    userId: 'user-1',
    accountId: 'account-1',
    kind: 'reply',
    to: headers.to,
    cc: headers.cc,
    bcc: [],
    subject: headers.subject,
    bodyText: over.bodyText ?? REPLY_TEXT,
    references: headers.references,
    inReplyTo: headers.inReplyTo,
    inReplyToMessageId: 'email-1',
    idempotencyKey: 'key-1',
    phoneNumber: PHONE,
    lastInboundAt: new Date(),
  };

  const provider = {
    send: vi.fn(async (_account: unknown, message: never) => {
      const m = message as {
        to: Array<{ address: string; name?: string }>;
        cc?: Array<{ address: string; name?: string }>;
        subject: string;
        bodyText: string;
        inReplyTo?: string;
        references?: string[];
      };
      const composed = composeMime({
        from: { address: SELF },
        to: m.to,
        ...(m.cc ? { cc: m.cc } : {}),
        subject: m.subject,
        bodyText: m.bodyText,
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
        ...(m.references ? { references: m.references } : {}),
      });
      rendered.raw = composed.raw;
      return { providerMessageId: 'sent-1', threadId: 't-1' };
    }),
    getMessage: vi.fn(async () => ({ attachments: [] })),
    getAttachment: vi.fn(),
  };

  const processor = new SendProcessor(
    { env: { REDIS_URL: 'redis://unused' } } as never,
    {
      load: async () => ({ id: 'account-1', userId: 'user-1', emailAddress: SELF }),
      providerFor: () => provider,
      decryptBody: async () => claimed.bodyText,
      markReauthRequired: vi.fn(),
    } as never,
    {
      claimForSending: vi.fn(async () => claimed),
      findForForward: vi.fn(async () => null),
      markSent: vi.fn(),
      markFailed: vi.fn(),
    } as never,
    { listForDraft: async () => [] } as never,
    { reply: vi.fn() } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );

  return {
    send: () => processor.handle({ data: { userId: 'user-1', draftId: 'draft-1' } } as never),
    raw: () => rendered.raw!,
  };
}

/** The header block only — a word in the body is the user's own writing. */
function headerBlock(raw: string): string {
  return raw.split('\r\n\r\n')[0]!;
}

/**
 * The body as a recipient's client would show it.
 *
 * Bodies go out base64-encoded, so a substring check against the raw message
 * silently passes for text that is not there — and would have failed to notice
 * a body that was empty, doubled or someone else's.
 */
function bodyText(raw: string): string {
  const head = headerBlock(raw);
  const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  return /base64/i.test(head)
    ? Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
    : body;
}

describe('the email a recipient receives', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    h = harness();
    await h.send();
  });

  it('says nothing about WhatsApp', async () => {
    // The promise, checked against the bytes rather than against an object
    // that will later become bytes.
    expect(h.raw().toLowerCase()).not.toContain('whatsapp');
    expect(h.raw()).not.toContain('wamid');
  });

  it('does not carry the user’s phone number', () => {
    // It is in the draft — `phoneNumber` is on the record the send path reads —
    // so nothing but the composition step keeps it out of the message.
    expect(h.raw()).not.toContain(PHONE);
    expect(h.raw()).not.toContain(PHONE.replace('+', ''));
  });

  it('comes from the user’s own address', () => {
    expect(headerBlock(h.raw())).toContain(`From: ${SELF}`);
  });

  it('threads onto the original in every client, not just Gmail', () => {
    // Gmail groups by its own threadId, which is passed separately. Every other
    // client threads on these two headers, and a reply that lands as a new
    // conversation is the most visible way to give the game away.
    const head = headerBlock(h.raw());
    expect(head).toContain('In-Reply-To: <CAF=q3@mail.acme.com>');
    expect(head.replace(/\r\n\s+/g, ' ')).toContain(
      'References: <root@acme.com> <CAF=q2@mail.acme.com> <CAF=q3@mail.acme.com>',
    );
  });

  it('prefixes the subject once', () => {
    const head = headerBlock(h.raw());
    expect(head).toContain('Subject: Re: Q3 report');
    expect(head).not.toContain('Re: Re:');
  });

  it('goes to the sender and nobody else by default', () => {
    const head = headerBlock(h.raw());
    // Unquoted: the builder quotes a display name only where RFC 5322 needs
    // it, and adding quotes that Gmail would not is itself a small tell.
    expect(head).toContain('To: Sarah Chen <sarah.chen@acme.com>');
    expect(head).not.toContain('tom@acme.com');
  });

  it('carries the words the user typed', () => {
    expect(bodyText(h.raw())).toContain('sending the numbers this afternoon');
  });

  it('emits no client or originating headers', () => {
    // The set a recipient could use to tell this apart from a reply typed in
    // Gmail. Checked here as well as in the builder's own tests because this is
    // the path a real reply takes.
    const head = headerBlock(h.raw());
    for (const header of ['X-Mailer', 'X-Originating', 'User-Agent', 'X-WEA', 'X-Sent-Via']) {
      expect(head).not.toContain(header);
    }
  });
});

describe('reply all', () => {
  it('copies the thread without copying the user back to themselves', async () => {
    const h = harness({ replyAll: true });
    await h.send();

    const head = headerBlock(h.raw());
    expect(head).toContain('tom@acme.com');
    // The user's own address on a Cc is the tell that a machine assembled this.
    expect(head.split('Cc:')[1]?.split('\r\n')[0]).not.toContain(SELF);
  });
});

describe('what the user typed', () => {
  it('survives non-ASCII intact', async () => {
    // Someone replying in Swahili, or with an em dash. A mojibake reply is the
    // other way a recipient learns something unusual is in the path.
    const h = harness({ bodyText: 'Nitatuma hesabu leo jioni — asante sana. Café ☕' });
    await h.send();

    const head = headerBlock(h.raw());
    expect(head).toMatch(/Content-Type: text\/plain; charset="?utf-8"?/i);

    const decoded = bodyText(h.raw());
    expect(decoded).toContain('asante sana');
    expect(decoded).toContain('Café ☕');
  });
});
