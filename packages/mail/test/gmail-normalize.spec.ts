import { describe, it, expect } from 'vitest';
import {
  normalizeGmailMessage,
  parseAddressList,
  parseSingleAddress,
  decodeEncodedWords,
  collectParts,
  htmlToText,
  type GmailMessage,
} from '../src/index.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('address parsing', () => {
  it('parses a bare address', () => {
    expect(parseSingleAddress('sarah@acme.com')).toEqual({ address: 'sarah@acme.com' });
  });

  it('parses name and address', () => {
    expect(parseSingleAddress('Sarah Chen <sarah@acme.com>')).toEqual({
      name: 'Sarah Chen',
      address: 'sarah@acme.com',
    });
  });

  it('lower-cases the address but preserves the display name', () => {
    expect(parseSingleAddress('Sarah Chen <Sarah@ACME.com>')).toEqual({
      name: 'Sarah Chen',
      address: 'sarah@acme.com',
    });
  });

  it('handles a quoted name containing a comma', () => {
    // Common in corporate mail; splitting naively on commas breaks it.
    expect(parseAddressList('"Chen, Sarah" <sarah@acme.com>, tom@acme.com')).toEqual([
      { name: 'Chen, Sarah', address: 'sarah@acme.com' },
      { address: 'tom@acme.com' },
    ]);
  });

  it('handles a comma inside angle brackets without splitting', () => {
    expect(parseAddressList('a@x.com, "B, C" <b@x.com>, d@x.com')).toHaveLength(3);
  });

  it('returns nothing for input with no address', () => {
    for (const input of ['', '   ', 'undisclosed-recipients:;', 'not an address']) {
      expect(parseSingleAddress(input), input).toBeNull();
    }
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it('parses an empty list without throwing', () => {
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('RFC 2047 encoded words', () => {
  it('decodes base64 UTF-8', () => {
    // Otherwise a sender named José shows up in WhatsApp as =?UTF-8?B?Sm9zw6k=?=
    expect(decodeEncodedWords('=?UTF-8?B?Sm9zw6k=?=')).toBe('José');
  });

  it('decodes quoted-printable', () => {
    expect(decodeEncodedWords('=?UTF-8?Q?Jos=C3=A9?=')).toBe('José');
    expect(decodeEncodedWords('=?UTF-8?Q?Sarah_Chen?=')).toBe('Sarah Chen');
  });

  it('decodes adjacent encoded words as one string', () => {
    const encoded = `=?UTF-8?B?${Buffer.from('你好').toString('base64')}?= =?UTF-8?B?${Buffer.from('世界').toString('base64')}?=`;
    expect(decodeEncodedWords(encoded)).toBe('你好世界');
  });

  it('leaves plain text alone', () => {
    expect(decodeEncodedWords('Sarah Chen')).toBe('Sarah Chen');
  });

  it('leaves a malformed encoded word visible rather than dropping the name', () => {
    expect(decodeEncodedWords('=?UTF-8?B?!!!not-base64!!!?=')).toContain('=?UTF-8?B?');
  });

  it('decodes an encoded display name inside an address', () => {
    expect(parseSingleAddress('=?UTF-8?B?Sm9zw6k=?= <jose@acme.com>')).toEqual({
      name: 'José',
      address: 'jose@acme.com',
    });
  });
});

describe('walking the MIME tree', () => {
  it('reads a simple text/plain message', () => {
    const parts = collectParts({ mimeType: 'text/plain', body: { data: b64('Hello there') } });
    expect(parts.text).toBe('Hello there');
    expect(parts.html).toBe('');
  });

  it('reads both parts of multipart/alternative', () => {
    const parts = collectParts({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('plain body') } },
        { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
      ],
    });
    expect(parts.text).toBe('plain body');
    expect(parts.html).toBe('<p>html body</p>');
  });

  it('descends through nested multiparts', () => {
    // mixed > alternative > related is a shape Gmail produces routinely.
    const parts = collectParts({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('deep text') } },
            {
              mimeType: 'multipart/related',
              parts: [
                { mimeType: 'text/html', body: { data: b64('<p>deep html</p>') } },
                {
                  mimeType: 'image/png',
                  filename: 'logo.png',
                  headers: [
                    { name: 'Content-Disposition', value: 'inline' },
                    { name: 'Content-ID', value: '<logo123>' },
                  ],
                  body: { attachmentId: 'att-logo', size: 4096 },
                },
              ],
            },
          ],
        },
        {
          mimeType: 'application/pdf',
          filename: 'report.pdf',
          body: { attachmentId: 'att-pdf', size: 102400 },
        },
      ],
    });

    expect(parts.text).toBe('deep text');
    expect(parts.html).toBe('<p>deep html</p>');
    expect(parts.attachments).toHaveLength(2);

    const inline = parts.attachments.find((a) => a.disposition === 'inline');
    expect(inline?.contentId).toBe('logo123');
    expect(inline?.filename).toBe('logo.png');

    const pdf = parts.attachments.find((a) => a.filename === 'report.pdf');
    expect(pdf?.sizeBytes).toBe(102400);
  });

  it('treats a text/plain part with a filename as an attachment', () => {
    // This is how a .txt attachment arrives; reading it as the body would put
    // the attachment's contents into the WhatsApp notification.
    const parts = collectParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64('the actual body') } },
        {
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { attachmentId: 'att-notes', size: 500 },
        },
      ],
    });

    expect(parts.text).toBe('the actual body');
    expect(parts.attachments.map((a) => a.filename)).toEqual(['notes.txt']);
  });

  it('bounds recursion depth', () => {
    let deep: any = { mimeType: 'text/plain', body: { data: b64('bottom') } };
    for (let i = 0; i < 200; i++) deep = { mimeType: 'multipart/mixed', parts: [deep] };
    expect(() => collectParts(deep)).not.toThrow();
  });

  it('survives a payload with no parts and no body', () => {
    expect(collectParts({ mimeType: 'text/plain' })).toEqual({
      text: '',
      html: '',
      attachments: [],
    });
    expect(collectParts(undefined)).toEqual({ text: '', html: '', attachments: [] });
  });
});

describe('HTML to text fallback', () => {
  it('strips tags and keeps the readable content', () => {
    expect(htmlToText('<p>Hello <b>there</b></p>')).toBe('Hello there');
  });

  it('drops style and script content entirely', () => {
    const html = '<style>.a{color:red}</style><script>alert(1)</script><p>Visible</p>';
    const text = htmlToText(html);
    expect(text).toBe('Visible');
    expect(text).not.toContain('color');
    expect(text).not.toContain('alert');
  });

  it('turns breaks and blocks into newlines', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('decodes entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3 &#39;quotes&#39;</p>')).toBe(
      "Tom & Jerry <3 'quotes'",
    );
  });

  it('marks list items', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toContain('• one');
  });
});

describe('normalizing a whole message', () => {
  const message: GmailMessage = {
    id: 'msg-1',
    threadId: 'thread-1',
    labelIds: ['INBOX', 'UNREAD', 'STARRED'],
    snippet: 'Could you send the Q3 report&#39;s summary?',
    internalDate: '1785849600000',
    sizeEstimate: 8192,
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Message-ID', value: '<parent@acme.com>' },
        { name: 'In-Reply-To', value: 'grandparent@acme.com' },
        { name: 'References', value: '<root@acme.com> <grandparent@acme.com>' },
        { name: 'Subject', value: '=?UTF-8?B?UTMgcmVwb3J0IOKAlCB1cmdlbnQ=?=' },
        { name: 'From', value: 'Sarah Chen <Sarah@ACME.com>' },
        { name: 'Reply-To', value: 'team@acme.com' },
        { name: 'To', value: 'me@example.com, "Chen, Tom" <tom@acme.com>' },
        { name: 'Cc', value: 'ops@acme.com' },
        { name: 'Date', value: 'Tue, 04 Aug 2026 13:00:00 +0000' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Could you send the Q3 report?') } },
        { mimeType: 'text/html', body: { data: b64('<p>Could you send the Q3 report?</p>') } },
      ],
    },
  };

  it('extracts the threading headers we depend on', () => {
    const normalized = normalizeGmailMessage(message);
    expect(normalized.messageIdHeader).toBe('<parent@acme.com>');
    // Brackets added even though Gmail returned it without them.
    expect(normalized.inReplyTo).toBe('<grandparent@acme.com>');
    expect(normalized.references).toEqual(['<root@acme.com>', '<grandparent@acme.com>']);
  });

  it('decodes the subject', () => {
    expect(normalizeGmailMessage(message).subject).toBe('Q3 report — urgent');
  });

  it('parses all address fields', () => {
    const normalized = normalizeGmailMessage(message);
    expect(normalized.from).toEqual({ name: 'Sarah Chen', address: 'sarah@acme.com' });
    expect(normalized.replyTo).toEqual({ address: 'team@acme.com' });
    expect(normalized.to).toHaveLength(2);
    expect(normalized.cc).toEqual([{ address: 'ops@acme.com' }]);
  });

  it('maps labels to flags', () => {
    const normalized = normalizeGmailMessage(message);
    expect(normalized.isUnread).toBe(true);
    expect(normalized.isStarred).toBe(true);
    expect(normalized.isDraft).toBe(false);
    expect(normalized.labels).toContain('INBOX');
  });

  it('trusts internalDate for arrival time', () => {
    // The Date header is whatever the sender's clock said, and is often wrong.
    const normalized = normalizeGmailMessage(message);
    expect(normalized.receivedAt.getTime()).toBe(1785849600000);
  });

  it('ignores an absurdly skewed Date header for ordering', () => {
    const skewed = {
      ...message,
      payload: {
        ...message.payload!,
        headers: [
          ...message.payload!.headers!.filter((h) => h.name !== 'Date'),
          { name: 'Date', value: 'Tue, 04 Aug 2035 13:00:00 +0000' },
        ],
      },
    };
    // Otherwise a spam message with a future date sits permanently at the top.
    const normalized = normalizeGmailMessage(skewed);
    expect(normalized.sentAt.getTime()).toBe(normalized.receivedAt.getTime());
  });

  it('decodes HTML entities in the snippet', () => {
    expect(normalizeGmailMessage(message).snippet).toContain("report's");
  });

  it('derives text from HTML when there is no plain part', () => {
    const htmlOnly: GmailMessage = {
      id: 'm',
      threadId: 't',
      payload: {
        mimeType: 'text/html',
        headers: [{ name: 'From', value: 'a@b.com' }],
        body: { data: b64('<p>Only HTML here</p>') },
      },
    };
    const normalized = normalizeGmailMessage(htmlOnly);
    expect(normalized.bodyText).toBe('Only HTML here');
    expect(normalized.bodyHtml).toBe('<p>Only HTML here</p>');
  });

  it('normalizes a message with no payload at all', () => {
    // Gmail returns this for some system messages; it must not throw.
    const bare: GmailMessage = { id: 'm', threadId: 't' };
    const normalized = normalizeGmailMessage(bare);
    expect(normalized.providerMessageId).toBe('m');
    expect(normalized.subject).toBe('');
    expect(normalized.bodyText).toBe('');
    expect(normalized.attachments).toEqual([]);
  });

  it('caps the snippet length', () => {
    const long: GmailMessage = {
      id: 'm',
      threadId: 't',
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'a@b.com' }],
        body: { data: b64('x'.repeat(5000)) },
      },
    };
    expect(normalizeGmailMessage(long).snippet.length).toBeLessThanOrEqual(200);
  });
});
