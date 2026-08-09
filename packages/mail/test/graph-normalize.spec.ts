import { describe, it, expect } from 'vitest';
import {
  normalizeGraphMessage,
  findGraphHeader,
  GRAPH_MESSAGE_SELECT,
  type GraphMessage,
} from '../src/index.js';

/**
 * Normalizing a Graph message.
 *
 * Less work than Gmail, because Graph has already parsed the MIME — and more
 * traps, because every one of them is a silent wrong answer rather than an
 * error. Threading headers that are simply absent unless requested; a
 * `conversationId` that is not a thread id; a body that is HTML far more often
 * than Gmail's.
 */

const message = (over: Partial<GraphMessage> = {}): GraphMessage => ({
  id: 'AAMkAGI2...',
  conversationId: 'AAQkAGI2...',
  internetMessageId: '<abc123@acme.com>',
  subject: 'Q3 report',
  bodyPreview: 'Could you send the Q3 report?',
  body: { contentType: 'text', content: 'Could you send the Q3 report before Friday?' },
  from: { emailAddress: { name: 'Sarah Chen', address: 'Sarah.Chen@ACME.com' } },
  toRecipients: [{ emailAddress: { address: 'me@example.com' } }],
  ccRecipients: [],
  sentDateTime: '2026-08-04T09:30:00Z',
  receivedDateTime: '2026-08-04T09:30:04Z',
  isRead: false,
  ...over,
});

describe('the select list', () => {
  it('names the headers, without which threading silently breaks', () => {
    // Graph omits `internetMessageHeaders` entirely unless it is asked for, and
    // it is the only place In-Reply-To and References live. Forget it and
    // replies quietly start new conversations in the recipient's client.
    expect(GRAPH_MESSAGE_SELECT).toContain('internetMessageHeaders');
    expect(GRAPH_MESSAGE_SELECT).toContain('internetMessageId');
    expect(GRAPH_MESSAGE_SELECT).toContain('conversationId');
  });
});

describe('threading', () => {
  it('reads In-Reply-To and References out of the headers', () => {
    const result = normalizeGraphMessage(
      message({
        internetMessageHeaders: [
          { name: 'In-Reply-To', value: '<parent@acme.com>' },
          { name: 'References', value: '<root@acme.com> <parent@acme.com>' },
        ],
      }),
    );

    expect(result.inReplyTo).toBe('<parent@acme.com>');
    expect(result.references).toEqual(['<root@acme.com>', '<parent@acme.com>']);
  });

  it('finds a header whatever case the sender used', () => {
    const found = findGraphHeader(
      message({ internetMessageHeaders: [{ name: 'IN-REPLY-TO', value: '<x@y>' }] }),
      'In-Reply-To',
    );
    expect(found).toBe('<x@y>');
  });

  it('leaves threading empty rather than inventing it when headers are absent', () => {
    const result = normalizeGraphMessage(message());

    expect(result.inReplyTo).toBeUndefined();
    expect(result.references).toEqual([]);
  });

  it('keeps the conversation id, which is what Outlook itself threads on', () => {
    // Not an RFC thread: Outlook groups by normalized subject too, so two
    // unrelated emails can share one. Still the right value to store.
    expect(normalizeGraphMessage(message()).providerThreadId).toBe('AAQkAGI2...');
  });

  it('falls back to the message id when there is no conversation', () => {
    const result = normalizeGraphMessage(message({ conversationId: undefined }));
    expect(result.providerThreadId).toBe('AAMkAGI2...');
  });
});

describe('the body', () => {
  it('downgrades HTML to text, because Outlook composes HTML by default', () => {
    const result = normalizeGraphMessage(
      message({
        body: { contentType: 'html', content: '<p>Could you send the <b>Q3</b> report?</p>' },
      }),
    );

    expect(result.bodyText).toContain('Q3 report');
    expect(result.bodyText).not.toContain('<b>');
    expect(result.bodyHtml).toContain('<b>');
  });

  it('keeps plain text as it is', () => {
    const result = normalizeGraphMessage(message());

    expect(result.bodyText).toBe('Could you send the Q3 report before Friday?');
    expect(result.bodyHtml).toBeUndefined();
  });

  it('prefers the preview for the snippet, and falls back to the body', () => {
    expect(normalizeGraphMessage(message()).snippet).toBe('Could you send the Q3 report?');
    expect(normalizeGraphMessage(message({ bodyPreview: undefined })).snippet).toContain(
      'before Friday',
    );
  });

  it('bounds the snippet', () => {
    const result = normalizeGraphMessage(
      message({ bodyPreview: undefined, body: { contentType: 'text', content: 'x'.repeat(900) } }),
    );
    expect(result.snippet.length).toBe(200);
  });
});

describe('addresses', () => {
  it('lower-cases the address and keeps the display name', () => {
    const result = normalizeGraphMessage(message());
    expect(result.from).toEqual({ name: 'Sarah Chen', address: 'sarah.chen@acme.com' });
  });

  it('drops a display name that is just the address again', () => {
    // Outlook fills `name` with the address when there is none, which renders
    // as "sarah@acme.com <sarah@acme.com>" on a notification card.
    const result = normalizeGraphMessage(
      message({ from: { emailAddress: { name: 'sarah@acme.com', address: 'sarah@acme.com' } } }),
    );

    expect(result.from).toEqual({ address: 'sarah@acme.com' });
  });

  it('falls back to the sender when there is no from', () => {
    const result = normalizeGraphMessage(
      message({
        from: undefined,
        sender: { emailAddress: { address: 'behalf@acme.com' } },
      }),
    );
    expect(result.from.address).toBe('behalf@acme.com');
  });

  it('never leaves the sender undefined, whatever Graph sent', () => {
    // A message with no from at all still has to normalize — a throw here would
    // take out ingest for one malformed item.
    const result = normalizeGraphMessage(message({ from: undefined, sender: undefined }));
    expect(result.from.address).toBe('unknown@invalid');
  });

  it('takes the first reply-to, since our reply goes to exactly one place', () => {
    const result = normalizeGraphMessage(
      message({ replyTo: [{ emailAddress: { address: 'noreply@acme.com' } }] }),
    );
    expect(result.replyTo?.address).toBe('noreply@acme.com');
  });
});

describe('flags and labels', () => {
  it('maps unread from isRead', () => {
    expect(normalizeGraphMessage(message({ isRead: false })).isUnread).toBe(true);
    expect(normalizeGraphMessage(message({ isRead: true })).isUnread).toBe(false);
  });

  it('maps Outlook’s flag onto starred, which is the same gesture', () => {
    const flagged = normalizeGraphMessage(message({ flag: { flagStatus: 'flagged' } }));
    const not = normalizeGraphMessage(message({ flag: { flagStatus: 'notFlagged' } }));

    expect(flagged.isStarred).toBe(true);
    expect(not.isStarred).toBe(false);
  });

  it('uses categories as labels, and not the folder', () => {
    // A folder is an opaque id rather than a name, so a caller asking for
    // "Archive" would get a base64 blob.
    const result = normalizeGraphMessage(
      message({ categories: ['Blue category'], parentFolderId: 'AAMkAD...' }),
    );

    expect(result.labels).toEqual(['Blue category']);
    expect(JSON.stringify(result.labels)).not.toContain('AAMkAD');
  });
});

describe('attachments', () => {
  it('normalizes a file attachment', () => {
    const result = normalizeGraphMessage(
      message({
        attachments: [
          {
            id: 'AAMkatt1',
            name: 'invoice.pdf',
            contentType: 'application/pdf',
            size: 48_120,
            isInline: false,
            '@odata.type': '#microsoft.graph.fileAttachment',
          },
        ],
      }),
    );

    expect(result.attachments).toEqual([
      {
        providerAttachmentId: 'AAMkatt1',
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 48_120,
        disposition: 'attachment',
      },
    ]);
  });

  it('marks an inline image inline and keeps its content id', () => {
    const result = normalizeGraphMessage(
      message({
        attachments: [
          {
            id: 'AAMkatt2',
            name: 'logo.png',
            contentType: 'image/png',
            size: 900,
            isInline: true,
            contentId: 'logo@acme',
            '@odata.type': '#microsoft.graph.fileAttachment',
          },
        ],
      }),
    );

    expect(result.attachments[0]).toMatchObject({ disposition: 'inline', contentId: 'logo@acme' });
  });

  it('drops an embedded Outlook item, which has no bytes to stream', () => {
    // A contact or a calendar entry attached to a message. Passing it through
    // would produce a download that always fails.
    const result = normalizeGraphMessage(
      message({
        attachments: [
          { id: 'i1', name: 'Sarah Chen', '@odata.type': '#microsoft.graph.itemAttachment' },
          { id: 'i2', name: 'link.url', '@odata.type': '#microsoft.graph.referenceAttachment' },
          { id: 'f1', name: 'ok.pdf', '@odata.type': '#microsoft.graph.fileAttachment' },
        ],
      }),
    );

    expect(result.attachments.map((a) => a.providerAttachmentId)).toEqual(['f1']);
  });
});

describe('dates', () => {
  it('keeps both sent and received', () => {
    const result = normalizeGraphMessage(message());

    expect(result.sentAt.toISOString()).toBe('2026-08-04T09:30:00.000Z');
    expect(result.receivedAt.toISOString()).toBe('2026-08-04T09:30:04.000Z');
  });

  it('falls back rather than producing an Invalid Date', () => {
    // An Invalid Date compares false against everything, so it would sort a
    // message to an arbitrary position rather than failing visibly.
    const result = normalizeGraphMessage(
      message({ sentDateTime: 'not a date', receivedDateTime: undefined }),
    );

    expect(Number.isNaN(result.sentAt.getTime())).toBe(false);
    expect(Number.isNaN(result.receivedAt.getTime())).toBe(false);
  });
});
