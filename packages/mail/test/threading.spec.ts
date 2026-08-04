import { describe, it, expect } from 'vitest';
import {
  buildReplyHeaders,
  buildReplySubject,
  buildForwardSubject,
  stripReplyPrefixes,
  normalizeMessageId,
  parseReferences,
  trimReferences,
  generateMessageId,
  resolveReplyRecipients,
} from '../src/index.js';

/**
 * Threading is the product. If these headers are wrong, the reply detaches from
 * the conversation in the recipient's client — the one failure they would
 * definitely notice.
 */

describe('reply headers', () => {
  it('sets In-Reply-To to the parent and appends it to References', () => {
    const headers = buildReplyHeaders({
      messageIdHeader: '<parent@acme.com>',
      references: ['<root@acme.com>', '<second@acme.com>'],
      subject: 'Q3 report',
    });

    expect(headers.inReplyTo).toBe('<parent@acme.com>');
    expect(headers.references).toEqual([
      '<root@acme.com>',
      '<second@acme.com>',
      '<parent@acme.com>',
    ]);
  });

  it('starts a References chain when the parent had none', () => {
    const headers = buildReplyHeaders({
      messageIdHeader: '<first@acme.com>',
      references: [],
      subject: 'Hello',
    });

    expect(headers.references).toEqual(['<first@acme.com>']);
    expect(headers.inReplyTo).toBe('<first@acme.com>');
  });

  it('keeps References oldest-first, which is the order clients walk', () => {
    const headers = buildReplyHeaders({
      messageIdHeader: '<c@x.com>',
      references: ['<a@x.com>', '<b@x.com>'],
      subject: 'x',
    });
    expect(headers.references[0]).toBe('<a@x.com>');
    expect(headers.references.at(-1)).toBe('<c@x.com>');
  });

  it('does not duplicate a parent already present in References', () => {
    // Some clients already include the parent; appending it again produces a
    // malformed chain that compounds with every reply.
    const headers = buildReplyHeaders({
      messageIdHeader: '<parent@x.com>',
      references: ['<root@x.com>', '<parent@x.com>'],
      subject: 'x',
    });
    expect(headers.references).toEqual(['<root@x.com>', '<parent@x.com>']);
  });

  it('deduplicates a chain that arrived malformed', () => {
    const headers = buildReplyHeaders({
      messageIdHeader: '<p@x.com>',
      references: ['<a@x.com>', '<a@x.com>', '<b@x.com>', '<a@x.com>'],
      subject: 'x',
    });
    expect(headers.references).toEqual(['<a@x.com>', '<b@x.com>', '<p@x.com>']);
  });

  it('adds angle brackets when a provider omitted them', () => {
    // Gmail returns them; Graph sometimes does not. An In-Reply-To without
    // brackets is malformed and some clients will not match it.
    const headers = buildReplyHeaders({
      messageIdHeader: 'parent@acme.com',
      references: ['root@acme.com'],
      subject: 'x',
    });
    expect(headers.inReplyTo).toBe('<parent@acme.com>');
    expect(headers.references).toEqual(['<root@acme.com>', '<parent@acme.com>']);
  });

  it('survives a missing parent Message-ID without producing garbage', () => {
    const headers = buildReplyHeaders({
      messageIdHeader: '',
      references: ['<root@x.com>'],
      subject: 'x',
    });
    expect(headers.inReplyTo).toBe('');
    expect(headers.references).toEqual(['<root@x.com>']);
  });
});

describe('trimming a long References chain', () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => `<msg-${i}@example.com>`);

  it('leaves a short chain untouched', () => {
    expect(trimReferences(chain(4))).toEqual(chain(4));
  });

  it('drops from the middle, never the end', () => {
    // The end holds the parent. Trimming from the end — the obvious
    // implementation — detaches the reply from its own conversation.
    const trimmed = trimReferences(chain(60));

    expect(trimmed.length).toBeLessThan(60);
    expect(trimmed[0]).toBe('<msg-0@example.com>');
    expect(trimmed.at(-1)).toBe('<msg-59@example.com>');
  });

  it('keeps the root, which anchors the conversation', () => {
    expect(trimReferences(chain(100))[0]).toBe('<msg-0@example.com>');
  });

  it('keeps the most recent ancestors', () => {
    const trimmed = trimReferences(chain(100));
    expect(trimmed).toContain('<msg-99@example.com>');
    expect(trimmed).toContain('<msg-98@example.com>');
  });

  it('brings the header under a practical length', () => {
    expect(trimReferences(chain(200)).join(' ').length).toBeLessThanOrEqual(900);
  });
});

describe('reply subjects', () => {
  it('adds Re: once', () => {
    expect(buildReplySubject('Q3 report')).toBe('Re: Q3 report');
  });

  it('does not stack prefixes', () => {
    for (const subject of ['Re: Q3 report', 'RE: Q3 report', 're: Q3 report', 'Re : Q3 report']) {
      expect(buildReplySubject(subject), subject).toBe('Re: Q3 report');
    }
  });

  it('collapses a pile accumulated across clients', () => {
    expect(buildReplySubject('Re: RE: Re: Q3 report')).toBe('Re: Q3 report');
  });

  it('recognizes localized and numbered prefixes', () => {
    // A thread that has crossed a German, Nordic or Outlook client.
    expect(buildReplySubject('AW: Q3 report')).toBe('Re: Q3 report');
    expect(buildReplySubject('SV: Q3 report')).toBe('Re: Q3 report');
    expect(buildReplySubject('Re[2]: Q3 report')).toBe('Re: Q3 report');
    expect(buildReplySubject('回复: Q3 report')).toBe('Re: Q3 report');
  });

  it('handles an empty subject', () => {
    expect(buildReplySubject('')).toBe('Re:');
    expect(buildReplySubject('Re:')).toBe('Re:');
  });

  it('does not strip a subject that merely begins with those letters', () => {
    expect(buildReplySubject('Recruitment update')).toBe('Re: Recruitment update');
    expect(buildReplySubject('Result of the audit')).toBe('Re: Result of the audit');
  });

  it('terminates on adversarial input', () => {
    const start = Date.now();
    expect(() => buildReplySubject('Re: '.repeat(10_000) + 'x')).not.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('forward subjects', () => {
  it('adds Fwd: and strips any reply prefix', () => {
    expect(buildForwardSubject('Q3 report')).toBe('Fwd: Q3 report');
    expect(buildForwardSubject('Re: Q3 report')).toBe('Fwd: Q3 report');
  });

  it('leaves an existing forward prefix alone', () => {
    expect(buildForwardSubject('Fwd: Q3 report')).toBe('Fwd: Q3 report');
    expect(buildForwardSubject('FW: Q3 report')).toBe('FW: Q3 report');
  });
});

describe('Message-ID handling', () => {
  it('normalizes to angle-bracket form', () => {
    expect(normalizeMessageId('<a@b.com>')).toBe('<a@b.com>');
    expect(normalizeMessageId('a@b.com')).toBe('<a@b.com>');
    expect(normalizeMessageId('  <a@b.com>  ')).toBe('<a@b.com>');
    expect(normalizeMessageId('<<a@b.com>>')).toBe('<a@b.com>');
  });

  it('returns empty for nothing usable', () => {
    for (const input of [undefined, '', '   ', '<>', '<<>>']) {
      expect(normalizeMessageId(input), String(input)).toBe('');
    }
  });

  it('parses a References header into ids', () => {
    expect(parseReferences('<a@x.com> <b@x.com>\r\n <c@x.com>')).toEqual([
      '<a@x.com>',
      '<b@x.com>',
      '<c@x.com>',
    ]);
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences('garbage with no ids')).toEqual([]);
  });

  it('generates an id under the user’s own domain, never ours', () => {
    // A recipient inspecting headers must see an id consistent with the sending
    // address, exactly as their own client would produce (ADR 0003).
    const id = generateMessageId('sarah@acme.com', 'abc123');
    expect(id).toBe('<abc123@acme.com>');
    expect(id).not.toContain('whatsapp');
    expect(id).not.toContain('wea');
  });
});

describe('reply recipients', () => {
  const original = {
    from: { name: 'Sarah Chen', address: 'sarah@acme.com' },
    to: [{ address: 'me@example.com' }, { name: 'Tom', address: 'tom@acme.com' }],
    cc: [{ address: 'ops@acme.com' }],
  };

  it('replies to the sender', () => {
    const { to, cc } = resolveReplyRecipients(original, 'me@example.com', false);
    expect(to).toEqual([{ name: 'Sarah Chen', address: 'sarah@acme.com' }]);
    expect(cc).toEqual([]);
  });

  it('prefers Reply-To over From', () => {
    // Ignoring Reply-To sends mailing-list replies to the wrong place.
    const { to } = resolveReplyRecipients(
      { ...original, replyTo: { address: 'list@acme.com' } },
      'me@example.com',
      false,
    );
    expect(to).toEqual([{ address: 'list@acme.com' }]);
  });

  it('copies everyone else on reply-all', () => {
    const { to, cc } = resolveReplyRecipients(original, 'me@example.com', true);
    expect(to).toEqual([{ name: 'Sarah Chen', address: 'sarah@acme.com' }]);
    expect(cc.map((c) => c.address)).toEqual(['tom@acme.com', 'ops@acme.com']);
  });

  it('never CCs the user their own reply', () => {
    const { cc } = resolveReplyRecipients(original, 'me@example.com', true);
    expect(cc.map((c) => c.address)).not.toContain('me@example.com');
  });

  it('matches the user’s own address case-insensitively', () => {
    const { cc } = resolveReplyRecipients(original, 'ME@Example.com', true);
    expect(cc.map((c) => c.address)).not.toContain('me@example.com');
  });

  it('does not duplicate the primary recipient into CC', () => {
    const withSelfCc = { ...original, cc: [{ address: 'sarah@acme.com' }] };
    const { cc } = resolveReplyRecipients(withSelfCc, 'me@example.com', true);
    expect(cc.map((c) => c.address)).not.toContain('sarah@acme.com');
  });
});
