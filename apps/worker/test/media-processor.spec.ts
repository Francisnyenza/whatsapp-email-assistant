import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { MediaProcessor, MAX_DELIVERABLE_BYTES } from '../src/processors/media.processor.js';

/**
 * Delivering an email's attachments into the chat.
 *
 * `QUEUE.MEDIA` was declared in the shared constants — with its own concurrency
 * and retry policy — and had no producer and no consumer for the life of the
 * project. A notification named an email's attachments and nothing ever sent
 * them. These tests cover the consumer that closes it.
 *
 * Two of them matter more than the rest. The size cap is enforced while reading
 * rather than from the stored `sizeBytes`, because a row that disagrees with
 * reality is exactly what an oversized file looks like — and twenty concurrent
 * unbounded downloads in a worker with a 1 GB limit is an OOM kill whose alert
 * fires long after attachments stopped arriving. And every refusal is a
 * sentence the user reads, because "I asked for the attachment and nothing
 * happened" is indistinguishable from the product being broken.
 */

describe('delivering an attachment', () => {
  it('uploads the bytes and sends them as a document', async () => {
    const { processor, outbound } = build({ bytes: Buffer.from('%PDF-1.7 hello') });

    await processor.handle(job());

    expect(outbound.uploadMedia).toHaveBeenCalledWith(
      Buffer.from('%PDF-1.7 hello'),
      'application/pdf',
      'invoice.pdf',
    );
    expect(outbound.reply.mock.calls.at(-1)![0].payload).toMatchObject({
      kind: 'media',
      mediaType: 'document',
      filename: 'invoice.pdf',
    });
  });

  it('sends an image as an image, so it renders rather than needing a tap', async () => {
    const { processor, outbound } = build({
      bytes: Buffer.from('\x89PNG'),
      attachment: { mimeType: 'image/png', filename: 'chart.png' },
    });

    await processor.handle(job());

    const payload = outbound.reply.mock.calls.at(-1)![0].payload;
    expect(payload).toMatchObject({ mediaType: 'image' });
    // A caption on an image is dropped by Meta; the filename would vanish.
    expect(payload).not.toHaveProperty('filename');
  });

  it('routes through the account’s own adapter', async () => {
    // The bug fixed two commits ago: a hardcoded 'gmail' here would download a
    // Microsoft attachment through the Gmail adapter.
    const { processor, providerFor } = build({
      bytes: Buffer.from('x'),
      accountProvider: 'outlook',
    });

    await processor.handle(job());

    expect(providerFor).toHaveBeenCalledWith('outlook');
  });
});

describe('the size cap', () => {
  it('refuses a file past the limit and says why', async () => {
    const { processor, outbound } = build({ bytes: Buffer.alloc(MAX_DELIVERABLE_BYTES + 1) });

    await processor.handle(job());

    expect(outbound.uploadMedia).not.toHaveBeenCalled();
    expect(textOf(outbound)).toContain('larger than I can send');
    // Still on the email, and saying so is the difference between a limitation
    // and a loss.
    expect(textOf(outbound)).toContain('still on the email');
  });

  it('counts the bytes it actually read, not the size the row claims', async () => {
    // A provider that under-reports, or a stale row, is the one case where a
    // declared-size check would not run.
    const { processor, outbound } = build({
      bytes: Buffer.alloc(MAX_DELIVERABLE_BYTES + 1),
      attachment: { sizeBytes: 12 },
    });

    await processor.handle(job());

    expect(outbound.uploadMedia).not.toHaveBeenCalled();
  });

  it('stops pulling the stream rather than draining it to discard it', async () => {
    // Without this the rest of a 200 MB file still crosses the network.
    const { processor, destroyed } = build({ bytes: Buffer.alloc(MAX_DELIVERABLE_BYTES + 1) });

    await processor.handle(job());

    expect(destroyed()).toBe(true);
  });

  it('sends a file exactly at the limit', async () => {
    const { processor, outbound } = build({ bytes: Buffer.alloc(MAX_DELIVERABLE_BYTES) });

    await processor.handle(job());

    expect(outbound.uploadMedia).toHaveBeenCalled();
  });
});

describe('what it will not send', () => {
  it('refuses something flagged as malicious', async () => {
    const { processor, outbound } = build({
      bytes: Buffer.from('x'),
      attachment: { isMalicious: true },
    });

    await processor.handle(job());

    expect(outbound.uploadMedia).not.toHaveBeenCalled();
    expect(textOf(outbound)).toContain('flagged as malicious');
  });

  it('sends something that was never scanned, rather than pretending it was clean', async () => {
    // `null` means not scanned, not safe. Nothing sets the column yet, so
    // refusing on null would block every attachment — and this is the user's own
    // mail, which any client hands them unscanned. The mistake to avoid is the
    // opposite one: treating null as a clean result and saying so.
    const { processor, outbound } = build({
      bytes: Buffer.from('x'),
      attachment: { isMalicious: null },
    });

    await processor.handle(job());

    expect(outbound.uploadMedia).toHaveBeenCalled();
    expect(textOf(outbound)).not.toContain('safe');
    expect(textOf(outbound)).not.toContain('scanned');
  });

  it('refuses an inline part, which is a signature logo', async () => {
    const { processor, outbound } = build({
      bytes: Buffer.from('x'),
      attachment: { disposition: 'inline', filename: 'logo.png' },
    });

    await processor.handle(job());

    expect(outbound.uploadMedia).not.toHaveBeenCalled();
    expect(textOf(outbound)).toContain('message layout');
  });
});

describe('when there is nothing to deliver to', () => {
  it('says nothing and sends nothing when the attachment is gone', async () => {
    // Deleted, purged by retention, or another tenant's — deliberately
    // indistinguishable, because RLS is what makes the third resolve to nothing.
    const { processor, outbound } = build({ bytes: Buffer.from('x'), context: null });

    await processor.handle(job());

    expect(outbound.reply).not.toHaveBeenCalled();
    expect(outbound.uploadMedia).not.toHaveBeenCalled();
  });

  it('refuses to deliver to an unverified number', async () => {
    // The same seal every other delivery path applies. A typo'd number would
    // send someone's private files to a stranger's phone.
    const { processor, outbound } = build({ bytes: Buffer.from('x'), phoneNumber: null });

    await processor.handle(job());

    expect(outbound.reply).not.toHaveBeenCalled();
    expect(outbound.uploadMedia).not.toHaveBeenCalled();
  });
});

/* --------------------------------- helpers -------------------------------- */

const ATTACHMENT = {
  id: 'att-1',
  providerAttachmentId: 'prov-att-1',
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  disposition: 'attachment',
  isMalicious: null as boolean | null,
};

function build(input: {
  bytes: Buffer;
  attachment?: Partial<typeof ATTACHMENT>;
  accountProvider?: string;
  phoneNumber?: string | null;
  context?: null;
}) {
  let wasDestroyed = false;
  const stream = Readable.from([input.bytes]);
  const originalDestroy = stream.destroy.bind(stream);
  stream.destroy = ((...args: unknown[]) => {
    wasDestroyed = true;
    return originalDestroy(...(args as []));
  }) as typeof stream.destroy;

  const outbound = {
    reply: vi.fn().mockResolvedValue(undefined),
    uploadMedia: vi.fn().mockResolvedValue('media-1'),
  };

  const providerFor = vi.fn().mockReturnValue({ getAttachment: async () => stream });

  const context =
    input.context === null
      ? null
      : {
          attachment: { ...ATTACHMENT, ...input.attachment },
          accountId: 'acct-1',
          providerMessageId: 'prov-msg-1',
          phoneNumber: input.phoneNumber === undefined ? '+254700000000' : input.phoneNumber,
          lastInboundAt: new Date(),
        };

  const processor = new MediaProcessor(
    { env: {} } as never,
    {
      load: async () => ({ id: 'acct-1', provider: input.accountProvider ?? 'gmail' }),
      providerFor,
    } as never,
    outbound as never,
    { findForDelivery: async () => context } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );

  return { processor, outbound, providerFor, destroyed: () => wasDestroyed };
}

function job() {
  return {
    data: { userId: 'user-1', emailMessageId: 'email-1', attachmentId: 'att-1' },
  } as never;
}

function textOf(outbound: { reply: ReturnType<typeof vi.fn> }): string {
  return outbound.reply.mock.calls.map((c) => c[0]?.payload?.body ?? '').join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
});
