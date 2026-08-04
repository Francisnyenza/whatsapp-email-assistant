import { describe, it, expect } from 'vitest';
import {
  composeMime,
  toGmailRaw,
  quoteOriginal,
  formatAddress,
  encodeHeaderValue,
  formatRfc2822Date,
  extractHeaderNames,
  ALLOWED_HEADERS,
  buildReplyHeaders,
} from '../src/index.js';
import { AppError } from '@wea/shared';

const base = {
  from: { name: 'Demo User', address: 'demo@example.com' },
  to: [{ name: 'Sarah Chen', address: 'sarah@acme.com' }],
  subject: 'Re: Q3 report',
  bodyText: 'Sending it this afternoon.',
  date: new Date('2026-08-04T14:30:00Z'),
  messageId: '<fixed-id@example.com>',
  boundarySeed: () => 'FIXEDBOUNDARY',
};

/** Decodes a base64 body part so assertions can read the actual content. */
function decodeParts(raw: string): string {
  return raw
    .split('\r\n\r\n')
    .slice(1)
    .join('\r\n\r\n')
    .split('\r\n')
    .map((line) => {
      if (/^[A-Za-z0-9+/=]{20,}$/.test(line)) {
        return Buffer.from(line, 'base64').toString('utf8');
      }
      return line;
    })
    .join('\n');
}

describe('the message carries no fingerprint', () => {
  // The rule that makes a WhatsApp reply indistinguishable from one typed in
  // Gmail (ADR 0003). This is the test that fails if someone adds branding.

  it('emits no header outside the allowlist', () => {
    const { raw } = composeMime({
      ...base,
      bodyHtml: '<p>Sending it this afternoon.</p>',
      inReplyTo: '<parent@acme.com>',
      references: ['<root@acme.com>', '<parent@acme.com>'],
      attachments: [
        { filename: 'report.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4') },
      ],
    });

    for (const name of extractHeaderNames(raw)) {
      expect(ALLOWED_HEADERS.has(name), `unexpected header: ${name}`).toBe(true);
    }
  });

  it('emits no X-Mailer or originating headers', () => {
    const { raw } = composeMime(base);
    const lower = raw.toLowerCase();
    for (const forbidden of ['x-mailer', 'x-originating', 'x-wea', 'user-agent', 'x-sender']) {
      expect(lower, forbidden).not.toContain(forbidden);
    }
  });

  it('mentions nothing about WhatsApp anywhere in the message', () => {
    const { raw } = composeMime({ ...base, bodyHtml: '<p>Sending it.</p>' });
    expect(raw.toLowerCase()).not.toContain('whatsapp');
    expect(decodeParts(raw).toLowerCase()).not.toContain('whatsapp');
  });

  it('uses the user’s own address in From and Message-ID', () => {
    const { raw, messageId } = composeMime({ ...base, messageId: undefined });
    expect(raw).toContain('From: Demo User <demo@example.com>');
    expect(messageId).toMatch(/@example\.com>$/);
  });
});

describe('threading headers reach the wire', () => {
  it('emits In-Reply-To and References together', () => {
    const headers = buildReplyHeaders({
      messageIdHeader: '<parent@acme.com>',
      references: ['<root@acme.com>'],
      subject: 'Q3 report',
    });

    const { raw } = composeMime({
      ...base,
      subject: headers.subject,
      inReplyTo: headers.inReplyTo,
      references: headers.references,
    });

    expect(raw).toContain('In-Reply-To: <parent@acme.com>');
    expect(raw).toContain('References: <root@acme.com> <parent@acme.com>');
    expect(raw).toContain('Subject: Re: Q3 report');
  });

  it('omits threading headers entirely on a fresh compose', () => {
    const { raw } = composeMime(base);
    expect(raw).not.toContain('In-Reply-To:');
    expect(raw).not.toContain('References:');
  });

  it('folds a long References header across continuation lines', () => {
    const references = Array.from({ length: 6 }, (_, i) => `<message-id-number-${i}@example.com>`);
    const { raw } = composeMime({ ...base, inReplyTo: references.at(-1)!, references });

    const headerBlock = raw.split('\r\n\r\n')[0]!;
    for (const line of headerBlock.split('\r\n')) {
      expect(line.length, line).toBeLessThanOrEqual(998); // RFC 5322 hard limit
    }
    // Every id still present after folding.
    for (const id of references) expect(headerBlock).toContain(id);
  });
});

describe('structure', () => {
  it('sends text/plain alone when there is no HTML', () => {
    const { raw } = composeMime(base);
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).not.toContain('multipart');
  });

  it('sends multipart/alternative with both bodies', () => {
    const { raw } = composeMime({ ...base, bodyHtml: '<p>Sending it.</p>' });
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="alt_FIXEDBOUNDARY"');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');

    const decoded = decodeParts(raw);
    expect(decoded).toContain('Sending it this afternoon.');
    expect(decoded).toContain('<p>Sending it.</p>');
  });

  it('nests alternative inside mixed when attachments are present', () => {
    const { raw } = composeMime({
      ...base,
      bodyHtml: '<p>See attached.</p>',
      attachments: [
        { filename: 'report.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.4') },
      ],
    });

    expect(raw).toContain('Content-Type: multipart/mixed');
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
  });

  it('closes every boundary', () => {
    const { raw } = composeMime({
      ...base,
      bodyHtml: '<p>x</p>',
      attachments: [{ filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('hi') }],
    });

    // An unclosed boundary produces a message that some clients render as empty.
    expect(raw).toContain('--mixed_FIXEDBOUNDARY--');
    expect(raw).toContain('--alt_FIXEDBOUNDARY--');
  });

  it('wraps base64 bodies at 76 characters per RFC 2045', () => {
    const { raw } = composeMime({ ...base, bodyText: 'x'.repeat(5000) });
    const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    for (const line of body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('round-trips attachment bytes exactly', () => {
    const content = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x0d, 0x0a]);
    const { raw } = composeMime({
      ...base,
      attachments: [{ filename: 'binary.dat', mimeType: 'application/octet-stream', content }],
    });

    const encoded = raw.split('Content-Disposition: attachment')[1]!.split('\r\n\r\n')[1]!;
    const decoded = Buffer.from(encoded.split('\r\n--')[0]!.replace(/\r\n/g, ''), 'base64');
    expect(Buffer.compare(decoded, content)).toBe(0);
  });

  it('uses CRLF line endings throughout the header block', () => {
    // Bare LF in headers is rejected outright by some MTAs.
    const headerBlock = composeMime(base).raw.split('\r\n\r\n')[0]!;
    expect(headerBlock).not.toMatch(/[^\r]\n/);
  });
});

describe('addresses and encoding', () => {
  it('formats a plain address', () => {
    expect(formatAddress({ address: 'sarah@acme.com' })).toBe('sarah@acme.com');
  });

  it('formats a display name', () => {
    expect(formatAddress({ name: 'Sarah Chen', address: 'sarah@acme.com' })).toBe(
      'Sarah Chen <sarah@acme.com>',
    );
  });

  it('quotes a name containing a period', () => {
    // Unquoted, the period is a special character in the address grammar.
    expect(formatAddress({ name: 'Dr. Chen', address: 'chen@acme.com' })).toBe(
      '"Dr. Chen" <chen@acme.com>',
    );
  });

  it('encodes a non-ASCII display name', () => {
    // Without this, "José" arrives as mojibake — exactly the kind of tell this
    // system must not produce.
    const formatted = formatAddress({ name: 'José Álvarez', address: 'jose@acme.com' });
    expect(formatted).toMatch(/^=\?UTF-8\?B\?/);
    expect(formatted).toContain('<jose@acme.com>');
  });

  it('encodes a non-ASCII subject and leaves ASCII alone', () => {
    expect(encodeHeaderValue('Q3 report')).toBe('Q3 report');
    expect(encodeHeaderValue('Ripoti ya robo — 你好')).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('splits long encoded words at character boundaries', () => {
    // Splitting mid-sequence renders as a replacement character.
    const encoded = encodeHeaderValue('你好世界'.repeat(30));
    for (const word of encoded.split('\r\n ')) {
      expect(word.length).toBeLessThanOrEqual(75);
      const payload = word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
      expect(() => Buffer.from(payload, 'base64').toString('utf8')).not.toThrow();
    }
    const rejoined = encoded
      .split('\r\n ')
      .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64'))
      .reduce((a, b) => Buffer.concat([a, b]));
    expect(rejoined.toString('utf8')).toBe('你好世界'.repeat(30));
  });

  it('formats an RFC 2822 date', () => {
    expect(formatRfc2822Date(new Date('2026-08-04T14:30:05Z'))).toBe(
      'Tue, 04 Aug 2026 14:30:05 +0000',
    );
  });
});

describe('header injection', () => {
  // A display name here can come from an AI draft or a user's WhatsApp message,
  // so this is not theoretical: a newline in a name turns it into a Bcc.

  it('rejects a newline in a display name', () => {
    expect(() =>
      composeMime({
        ...base,
        from: { name: 'Evil\r\nBcc: attacker@evil.com', address: 'a@b.com' },
      }),
    ).toThrow(AppError);
  });

  it('rejects a newline in an address', () => {
    expect(() =>
      composeMime({ ...base, to: [{ address: 'x@y.com\r\nBcc: attacker@evil.com' }] }),
    ).toThrow(AppError);
  });

  it('rejects a bare LF and a null byte', () => {
    for (const name of ['Evil\nBcc: x@y.com', 'Evil\0name']) {
      expect(() => composeMime({ ...base, from: { name, address: 'a@b.com' } }), name).toThrow(
        AppError,
      );
    }
  });

  it('collapses a newline in a subject so it cannot become a header', () => {
    const { raw } = composeMime({ ...base, subject: 'Hello\r\nBcc: attacker@evil.com' });
    const headerBlock = raw.split('\r\n\r\n')[0]!;

    // The text survives, but only as part of the Subject value on one line —
    // what matters is that no line *starts* with Bcc:.
    expect(headerBlock).toContain('Subject: Hello Bcc: attacker@evil.com');
    for (const line of headerBlock.split('\r\n')) {
      expect(line.toLowerCase().startsWith('bcc:')).toBe(false);
    }
    expect(extractHeaderNames(raw)).not.toContain('bcc');
  });

  it('strips every header-significant character from a filename', () => {
    const { raw } = composeMime({
      ...base,
      attachments: [
        {
          filename: 'evil".pdf\r\nContent-Type: text/html',
          mimeType: 'application/pdf',
          content: Buffer.from('x'),
        },
      ],
    });
    expect(raw).not.toContain('filename="evil".pdf');
    // No colon or semicolon survives, so nothing in the name can read as another
    // parameter or field.
    const disposition = raw.split('Content-Disposition: ')[1]!.split('\r\n')[0]!;
    expect(disposition).toBe('attachment; filename="evil.pdfContent-Type text/html"');
  });

  it('falls back to octet-stream for a MIME type that is not well-formed', () => {
    // Validated, not sanitized: stripping the dangerous characters would leave
    // `text/plainX-Evil: 1`, which is no longer an injection but is still a
    // malformed Content-Type a lenient parser might misread.
    const { raw } = composeMime({
      ...base,
      attachments: [
        { filename: 'a.txt', mimeType: 'text/plain";\r\nX-Evil: 1', content: Buffer.from('x') },
      ],
    });

    expect(raw.toLowerCase()).not.toContain('x-evil');
    expect(raw).toContain('Content-Type: application/octet-stream; name="a.txt"');
  });

  it('keeps a well-formed MIME type intact', () => {
    const { raw } = composeMime({
      ...base,
      attachments: [
        {
          filename: 'a.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          content: Buffer.from('x'),
        },
      ],
    });
    expect(raw).toContain(
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;',
    );
  });
});

describe('validation', () => {
  it('refuses a message with no recipients', () => {
    expect(() => composeMime({ ...base, to: [] })).toThrow(AppError);
  });

  it('handles an empty body', () => {
    // An email can legitimately be subject-only.
    expect(() => composeMime({ ...base, bodyText: '' })).not.toThrow();
  });
});

describe('Gmail encoding', () => {
  it('encodes as unpadded base64url', () => {
    const encoded = toGmailRaw(composeMime(base).raw);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toContain('Subject: Re: Q3 report');
  });
});

describe('quoting the original', () => {
  const original = {
    from: { name: 'Sarah Chen', address: 'sarah@acme.com' },
    sentAt: new Date('2026-08-03T09:15:00Z'),
    bodyText: 'Could you send the Q3 report?\nThe board meets Monday.',
  };

  it('uses the attribution convention every client uses', () => {
    const quoted = quoteOriginal(original);
    expect(quoted).toMatch(/^On .*, Sarah Chen <sarah@acme\.com> wrote:/);
  });

  it('prefixes every line, including blank ones', () => {
    const quoted = quoteOriginal({ ...original, bodyText: 'one\n\ntwo' });
    const lines = quoted.split('\n').slice(1);
    for (const line of lines) expect(line.startsWith('>')).toBe(true);
  });

  it('falls back to the address when there is no display name', () => {
    const quoted = quoteOriginal({ ...original, from: { address: 'sarah@acme.com' } });
    expect(quoted).toContain('sarah@acme.com wrote:');
  });
});
