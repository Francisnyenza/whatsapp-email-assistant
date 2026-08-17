import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { AppError } from '@wea/shared';
import { SendProcessor } from '../src/processors/send.processor.js';

/**
 * Sending a forward.
 *
 * A reply carries nothing but words. A forward carries the original's files,
 * and the failure worth guarding against is the quiet one: a forward that
 * arrives without the invoice, after the user was told it went. They cannot see
 * that happen and cannot undo it.
 */

describe('forwarded attachments', () => {
  let processor: SendProcessor;
  let sentMessage: any;
  let claimed: any;
  let attachmentBytes: Map<string, Buffer>;
  let getAttachmentFailure: Error | null;
  let providerAttachments: Array<{
    providerAttachmentId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    disposition: string;
  }>;

  const markFailed = vi.fn();
  const markSent = vi.fn();
  const reply = vi.fn();

  beforeEach(() => {
    sentMessage = null;
    getAttachmentFailure = null;
    attachmentBytes = new Map([
      ['att-1', Buffer.from('%PDF-1.7 invoice')],
      ['att-2', Buffer.from('spreadsheet bytes')],
    ]);
    providerAttachments = [
      {
        providerAttachmentId: 'att-1',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 16,
        disposition: 'attachment',
      },
    ];

    claimed = {
      id: 'draft-1',
      accountId: 'account-1',
      kind: 'forward',
      to: [{ address: 'colleague@acme.com' }],
      cc: [],
      bcc: [],
      subject: 'Fwd: Q3 report',
      bodyText: '---------- Forwarded message ----------',
      references: [],
      inReplyToMessageId: 'email-1',
      idempotencyKey: 'key-1',
      phoneNumber: '+254700000000',
      lastInboundAt: new Date(),
    };

    markFailed.mockReset();
    markSent.mockReset();
    reply.mockReset();

    const provider = {
      send: vi.fn(async (_a: unknown, message: unknown) => {
        sentMessage = message;
        return { providerMessageId: 'sent-1', threadId: 't-1' };
      }),
      getMessage: vi.fn(async () => ({ attachments: providerAttachments })),
      getAttachment: vi.fn(async (_a: unknown, _m: string, attachmentId: string) => {
        if (getAttachmentFailure) throw getAttachmentFailure;
        // Chunked deliberately: the real stream arrives in pieces, and a
        // reassembly bug would corrupt every file over one chunk.
        const bytes = attachmentBytes.get(attachmentId) ?? Buffer.alloc(0);
        return Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]);
      }),
    };

    const accounts = {
      load: async () => ({ id: 'account-1', userId: 'user-1', emailAddress: 'me@example.com' }),
      providerFor: () => provider,
      decryptBody: async () => claimed.bodyText,
      markReauthRequired: vi.fn(),
    };

    const drafts = {
      claimForSending: vi.fn(async () => claimed),
      findForForward: vi.fn(async () => ({ id: 'email-1', providerMessageId: 'gm-1' })),
      markSent,
      markFailed,
    };

    processor = new SendProcessor(
      { env: { REDIS_URL: 'redis://unused' } } as never,
      accounts as never,
      drafts as never,
      { listForDraft: async () => [] } as never,
      { reply } as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    );
  });

  const send = () => processor.handle({ data: { userId: 'user-1', draftId: 'draft-1' } } as never);

  it('attaches the original’s files', async () => {
    await send();

    expect(sentMessage.attachments).toEqual([
      {
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        content: Buffer.from('%PDF-1.7 invoice'),
      },
    ]);
  });

  it('reassembles a stream that arrives in chunks', async () => {
    await send();

    expect(sentMessage.attachments[0].content.toString()).toBe('%PDF-1.7 invoice');
  });

  it('carries every attachment, not just the first', async () => {
    providerAttachments.push({
      providerAttachmentId: 'att-2',
      filename: 'numbers.xlsx',
      mimeType: 'application/vnd.ms-excel',
      sizeBytes: 17,
      disposition: 'attachment',
    });

    await send();

    expect(sentMessage.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'invoice.pdf',
      'numbers.xlsx',
    ]);
  });

  it('leaves inline images out', async () => {
    // They belong to the HTML body a forward does not reproduce; attaching them
    // would show the recipient the sender's signature logo as a file.
    providerAttachments.push({
      providerAttachmentId: 'att-2',
      filename: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: 17,
      disposition: 'inline',
    });

    await send();

    expect(sentMessage.attachments).toHaveLength(1);
  });

  it('fails the send rather than delivering a forward without its files', async () => {
    // The quiet failure this whole path exists to prevent.
    getAttachmentFailure = new AppError('PROVIDER_ERROR', 'attachment unavailable');

    await expect(send()).rejects.toThrow();
    expect(sentMessage).toBeNull();
    expect(markSent).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalled();
  });

  it('sends nothing extra for a reply', async () => {
    claimed.kind = 'reply';

    await send();

    expect(sentMessage.attachments).toBeUndefined();
  });

  it('sends nothing extra when the original is gone', async () => {
    // The forward's body was composed and stored; the quoted text still goes.
    providerAttachments.length = 0;

    await send();

    expect(sentMessage.attachments).toBeUndefined();
    expect(markSent).toHaveBeenCalled();
  });
});
