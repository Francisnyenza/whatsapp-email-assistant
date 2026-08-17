import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { SendProcessor } from '../src/processors/send.processor.js';

/**
 * The last step of the outbound-attachment path: a file the user sent into the
 * chat becoming bytes on the email.
 *
 * Everything upstream of this is a reference — a media id in a row, claimed by
 * a draft. If this step is wrong the user is told the email went, the recipient
 * receives it, and the photo they watched themselves attach is simply not
 * there. That is the failure the whole design is arranged around, so it is the
 * one tested at the end of the pipe rather than in the middle.
 */

describe('a draft carrying files from the chat', () => {
  it('puts them on the email', async () => {
    const { processor, sent } = build({
      staged: [file('photo.jpg', 'image/jpeg', Buffer.from('JPEGBYTES'))],
    });

    await processor.handle(job());

    expect(sent().attachments).toEqual([
      { filename: 'photo.jpg', mimeType: 'image/jpeg', content: Buffer.from('JPEGBYTES') },
    ]);
  });

  it('keeps the order the user sent them in', async () => {
    const { processor, sent } = build({
      staged: [
        file('first.pdf', 'application/pdf', Buffer.from('1')),
        file('second.pdf', 'application/pdf', Buffer.from('2')),
      ],
    });

    await processor.handle(job());

    expect(sent().attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'first.pdf',
      'second.pdf',
    ]);
  });

  it('carries both a forward’s own files and the chat’s', async () => {
    // "forward this to bob" while holding a photo. Dropping either half would
    // be silent.
    const { processor, sent } = build({
      kind: 'forward',
      forwarded: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', bytes: 'INV' }],
      staged: [file('photo.jpg', 'image/jpeg', Buffer.from('JPEG'))],
    });

    await processor.handle(job());

    expect(sent().attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'invoice.pdf',
      'photo.jpg',
    ]);
  });

  it('names the count in the confirmation', async () => {
    // The user cannot see the sent message, so "Sent to alice@acme.com." is
    // indistinguishable from an email that went without the file.
    const { processor, reply } = build({
      staged: [file('a.pdf', 'application/pdf', Buffer.from('A'))],
    });

    await processor.handle(job());

    expect(reply.mock.calls.at(-1)![0].payload.body).toContain('with the file');
  });

  it('fails the send rather than delivering an email without the file', async () => {
    // Meta keeps inbound media for 30 days, so a miss means it is genuinely
    // gone — and sending anyway is the failure the user cannot see and cannot
    // undo.
    const { processor, sent, markFailed } = build({
      staged: [file('gone.pdf', 'application/pdf', Buffer.from('X'))],
      fetchFails: true,
    });

    await expect(processor.handle(job())).rejects.toThrow();

    expect(sent).toThrow(); // nothing was sent at all
    expect(markFailed).toHaveBeenCalled();
  });

  it('sends an ordinary reply with no attachments key at all', async () => {
    const { processor, sent } = build({ staged: [] });

    await processor.handle(job());

    expect(sent()).not.toHaveProperty('attachments');
  });
});

/* --------------------------------- helpers -------------------------------- */

function file(filename: string, mimeType: string, content: Buffer) {
  return { id: filename, whatsappMediaId: `media-${filename}`, filename, mimeType, content };
}

function build(input: {
  kind?: string;
  staged: Array<{
    id: string;
    whatsappMediaId: string;
    filename: string;
    mimeType: string;
    content: Buffer;
  }>;
  forwarded?: Array<{ filename: string; mimeType: string; bytes: string }>;
  fetchFails?: boolean;
}) {
  let sentMessage: Record<string, unknown> | undefined;
  const reply = vi.fn(async () => undefined);
  const markFailed = vi.fn(async () => undefined);

  const provider = {
    send: vi.fn(async (_a: unknown, message: Record<string, unknown>) => {
      sentMessage = message;
      return { providerMessageId: 'sent-1', threadId: 't-1' };
    }),
    getMessage: vi.fn(async () => ({
      attachments: (input.forwarded ?? []).map((a, i) => ({
        providerAttachmentId: `p-${i}`,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.bytes.length,
        disposition: 'attachment',
      })),
    })),
    getAttachment: vi.fn(async (_a: unknown, _m: string, id: string) => {
      const index = Number(id.split('-')[1]);
      return Readable.from([Buffer.from(input.forwarded![index]!.bytes)]);
    }),
  };

  const processor = new SendProcessor(
    { env: { REDIS_URL: 'redis://unused' } } as never,
    {
      load: async () => ({ id: 'account-1', provider: 'gmail', emailAddress: 'me@example.com' }),
      providerFor: () => provider,
      decryptBody: async () => 'body',
      markReauthRequired: vi.fn(),
    } as never,
    {
      claimForSending: vi.fn(async () => ({
        id: 'draft-1',
        accountId: 'account-1',
        kind: input.kind ?? 'reply',
        to: [{ address: 'alice@acme.com' }],
        cc: [],
        subject: 'Re: Q3',
        bodyText: 'body',
        references: [],
        ...(input.kind === 'forward' ? { inReplyToMessageId: 'email-1' } : {}),
        idempotencyKey: 'key-1',
        phoneNumber: '+254700000000',
        lastInboundAt: new Date(),
      })),
      findForForward: vi.fn(async () => ({ id: 'email-1', providerMessageId: 'gm-1' })),
      markSent: vi.fn(async () => undefined),
      markFailed,
    } as never,
    { listForDraft: async () => input.staged } as never,
    {
      reply,
      fetchMedia: vi.fn(async (mediaId: string) => {
        if (input.fetchFails) throw new Error('media is gone');
        return input.staged.find((f) => f.whatsappMediaId === mediaId)!.content;
      }),
    } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );

  return {
    processor,
    reply,
    markFailed,
    sent: () => {
      if (!sentMessage) throw new Error('nothing was sent');
      return sentMessage as { attachments: Array<{ filename: string }> };
    },
  };
}

function job() {
  return { data: { userId: 'user-1', draftId: 'draft-1' } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});
