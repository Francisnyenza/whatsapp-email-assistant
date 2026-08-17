import { describe, it, expect, vi } from 'vitest';
import { MAX_OUTBOUND_ATTACHMENT_BYTES, STAGED_ATTACHMENT_TTL_MS } from '@wea/shared';
import {
  AttachmentStagingService,
  MAX_PENDING_FILES,
  fileNameFor,
} from '../src/services/attachment-staging.service.js';

/**
 * Accepting a file the user sends into the chat.
 *
 * The direction that did not exist. An email's attachments could be delivered
 * into WhatsApp; a photo sent back was parsed by the webhook, understood
 * completely, and dropped.
 *
 * Two things here carry more weight than the rest. The size is asked of Meta
 * rather than taken from the webhook, because the webhook does not carry one —
 * and a budget checked at send time is a budget checked after the user has been
 * told the email is going. And the running total is checked as well as the
 * single file, because three 8 MB photos are individually fine and together are
 * a message no provider will accept.
 */

describe('holding a file', () => {
  it('records it against Meta’s media id, not its bytes', async () => {
    const { service, staged } = build({ sizeBytes: 1024 });

    const outcome = await service.stage('user-1', message());

    expect(outcome).toMatchObject({ kind: 'staged', pendingCount: 1 });
    expect(staged.stage).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappMediaId: 'media-1', sizeBytes: 1024 }),
    );
  });

  it('trusts Meta’s content type over the client’s', async () => {
    // The webhook echoes what the sending client claimed. The recipient's mail
    // client will sniff the bytes, so the value that came with them wins.
    const { service, staged } = build({ sizeBytes: 10, mimeType: 'application/pdf' });

    await service.stage('user-1', message({ media: { mimeType: 'text/plain' } }));

    expect(staged.stage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'application/pdf' }),
    );
  });

  it('expires it a day after it was sent', async () => {
    const sentAt = new Date('2026-08-17T09:00:00Z');
    const { service, staged } = build({ sizeBytes: 10 });

    await service.stage('user-1', message({ timestamp: sentAt }));

    const { expiresAt } = staged.stage.mock.calls[0]![0];
    expect(expiresAt.getTime()).toBe(sentAt.getTime() + STAGED_ATTACHMENT_TTL_MS);
  });

  it('says nothing the second time Meta delivers the same webhook', async () => {
    const { service } = build({ sizeBytes: 10, alreadyStaged: true });

    expect(await service.stage('user-1', message())).toEqual({ kind: 'duplicate' });
  });
});

describe('the size budget', () => {
  it('refuses a file larger than an email can carry', async () => {
    const { service, staged } = build({ sizeBytes: MAX_OUTBOUND_ATTACHMENT_BYTES + 1 });

    const outcome = await service.stage('user-1', message());

    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('20 MB'));
    expect(staged.stage).not.toHaveBeenCalled();
  });

  it('counts what is already waiting, not just the file in hand', async () => {
    // Each of these is comfortably within the budget on its own.
    const half = MAX_OUTBOUND_ATTACHMENT_BYTES / 2;
    const { service, staged } = build({
      sizeBytes: half + 1,
      pending: [{ id: 'a', sizeBytes: half, whatsappMediaId: 'm', filename: 'f', mimeType: 'x' }],
    });

    const outcome = await service.stage('user-1', message());

    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(outcome).toHaveProperty('reason', expect.stringContaining('One file is'));
    expect(staged.stage).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the limit', async () => {
    const { service, staged } = build({ sizeBytes: MAX_OUTBOUND_ATTACHMENT_BYTES });

    await service.stage('user-1', message());

    expect(staged.stage).toHaveBeenCalled();
  });

  it('caps the count as well as the bytes', async () => {
    // Ten one-byte files are within budget and still a message nobody wants.
    const { service, staged } = build({
      sizeBytes: 1,
      pending: Array.from({ length: MAX_PENDING_FILES }, (_, i) => ({
        id: `a${i}`,
        sizeBytes: 1,
        whatsappMediaId: 'm',
        filename: 'f',
        mimeType: 'x',
      })),
    });

    const outcome = await service.stage('user-1', message());

    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(staged.stage).not.toHaveBeenCalled();
  });
});

describe('what counts as a file', () => {
  it('takes photos, documents, video and music', () => {
    for (const type of ['image', 'document', 'video', 'audio'] as const) {
      expect(AttachmentStagingService.isFile(message({ type }))).toBe(true);
    }
  });

  it('ignores a sticker, which nobody has ever meant to email', () => {
    expect(AttachmentStagingService.isFile(message({ type: 'sticker' }))).toBe(false);
  });

  it('ignores a voice note, which is dictation rather than an attachment', () => {
    // Attaching a four-second .ogg to someone's email would be a strange answer
    // to "reply saying I'll be there at six". Transcription is not built, and
    // pretending otherwise here is how it would go unnoticed.
    expect(
      AttachmentStagingService.isFile(message({ type: 'audio', media: { voice: true } })),
    ).toBe(false);
  });

  it('ignores a plain text message', () => {
    expect(AttachmentStagingService.isFile({ ...message(), type: 'text', media: undefined })).toBe(
      false,
    );
  });
});

describe('the name the recipient sees', () => {
  it('keeps the one the document arrived with', () => {
    expect(fileNameFor(message({ media: { filename: 'Q3 report.pdf' } }), 'application/pdf')).toBe(
      'Q3 report.pdf',
    );
  });

  it('invents one for a photo, which WhatsApp strips', () => {
    const name = fileNameFor(
      message({ type: 'image', timestamp: new Date('2026-08-17T09:30:00Z') }),
      'image/jpeg',
    );

    // Not `image.jpg`: a recipient receiving three of those cannot tell them
    // apart, and some clients silently drop the duplicates.
    expect(name).toBe('image-2026-08-17_09-30-00-000.jpg');
  });

  it('keeps a plausible extension for a type it does not know', () => {
    expect(fileNameFor(message({ type: 'image' }), 'image/heic')).toMatch(/\.heic$/);
  });

  it('strips what would inject a MIME header', () => {
    const name = fileNameFor(
      message({ media: { filename: 'in\nvo"ice/../q3.pdf' } }),
      'application/pdf',
    );

    expect(name).toBe('invoice..q3.pdf');
  });

  it('falls back rather than producing an empty name', () => {
    expect(fileNameFor(message({ media: { filename: '///' } }), 'application/pdf')).toBe(
      'attachment',
    );
  });
});

describe('when Meta cannot say what the file is', () => {
  it('raises rather than staging a file of unknown size', async () => {
    // Staging it anyway would put an unmeasured file on the next email and
    // discover the problem at the provider, after "sending…".
    const { service } = build({ sizeBytes: 1, describeFails: true });

    await expect(service.stage('user-1', message())).rejects.toThrow();
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(input: {
  sizeBytes: number;
  mimeType?: string;
  pending?: Array<{
    id: string;
    sizeBytes: number;
    whatsappMediaId: string;
    filename: string;
    mimeType: string;
  }>;
  alreadyStaged?: boolean;
  describeFails?: boolean;
}) {
  const outbound = {
    describeMedia: vi.fn(async () => {
      if (input.describeFails) throw new Error('media metadata unavailable');
      return { mimeType: input.mimeType ?? 'application/pdf', sizeBytes: input.sizeBytes };
    }),
  };

  const staged = {
    listPending: vi.fn(async () => input.pending ?? []),
    stage: vi.fn(async (args: { filename: string; expiresAt: Date }) =>
      input.alreadyStaged ? null : { id: 'staged-1', ...args },
    ),
    discardPending: vi.fn(async () => 0),
  };

  const service = new AttachmentStagingService(
    outbound as never,
    staged as never,
    {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
  );

  return { service, outbound, staged };
}

function message(overrides: Record<string, unknown> = {}) {
  const media = { id: 'media-1', mimeType: 'application/pdf', sha256: '' };
  return {
    id: 'wamid-1',
    from: '254700000000',
    timestamp: new Date('2026-08-17T09:00:00Z'),
    type: 'document',
    ...overrides,
    media: { ...media, ...((overrides.media as Record<string, unknown>) ?? {}) },
  } as never;
}
