import { describe, it, expect } from 'vitest';
import { buildForwardBody, buildForwardSubject } from '../src/index.js';

/**
 * The forwarded-message block.
 *
 * The recipient of a forward has to see an ordinary forwarded email — the block
 * every client renders and every reader recognises. Anything that looks
 * home-made betrays that a machine was in the middle, which is the one thing
 * this product promises not to do.
 */

const source = {
  from: { address: 'sarah.chen@acme.com', name: 'Sarah Chen' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  subject: 'Q3 report',
  sentAt: new Date('2026-08-04T09:30:00Z'),
  bodyText: 'Could you send the Q3 report before Friday?',
};

describe('the quoted block', () => {
  it('opens with the separator clients recognise', () => {
    expect(buildForwardBody(source)).toContain('---------- Forwarded message ----------');
  });

  it('carries From, Date, Subject and To', () => {
    const body = buildForwardBody(source);

    expect(body).toContain('From: Sarah Chen <sarah.chen@acme.com>');
    expect(body).toContain('Subject: Q3 report');
    expect(body).toContain('To: me@example.com');
    expect(body).toMatch(/Date: \w{3}, \d{1,2} \w{3} 2026/);
  });

  it('includes the original text', () => {
    expect(buildForwardBody(source)).toContain('Could you send the Q3 report before Friday?');
  });

  it('omits Cc when there was none', () => {
    expect(buildForwardBody(source)).not.toContain('Cc:');
  });

  it('includes Cc when there was one', () => {
    const body = buildForwardBody({ ...source, cc: [{ address: 'tom@acme.com' }] });
    expect(body).toContain('Cc: tom@acme.com');
  });

  it('handles an empty body without producing a broken block', () => {
    // Subject-only mail is common and forwarding it must still work.
    const body = buildForwardBody({ ...source, bodyText: '' });
    expect(body).toContain('Subject: Q3 report');
  });
});

describe("the user's own note", () => {
  it('goes above the quote, where a person would put it', () => {
    const body = buildForwardBody(source, 'Thoughts on this?');

    expect(body.indexOf('Thoughts on this?')).toBeLessThan(body.indexOf('---------- Forwarded'));
  });

  it('is omitted entirely when there is none', () => {
    expect(buildForwardBody(source).startsWith('----------')).toBe(true);
  });

  it('is omitted when it is only whitespace', () => {
    expect(buildForwardBody(source, '   \n  ').startsWith('----------')).toBe(true);
  });
});

describe('a hostile display name', () => {
  it('cannot forge an extra header line in the quote', () => {
    // The sender chooses their own display name. Without stripping, a name of
    // "Alice\nFrom: ceo@corp.com" would render as a second, convincing From
    // line inside the quoted block.
    const body = buildForwardBody({
      ...source,
      from: { address: 'alice@evil.com', name: 'Alice\nFrom: ceo@corp.com' },
    });

    const fromLines = body.split('\n').filter((line) => line.startsWith('From: '));
    expect(fromLines).toHaveLength(1);
    expect(fromLines[0]).toContain('alice@evil.com');
  });

  it('quotes a name containing address punctuation', () => {
    const body = buildForwardBody({
      ...source,
      from: { address: 'alice@evil.com', name: 'ceo@corp.com <real>' },
    });

    expect(body).toContain('<alice@evil.com>');
  });

  it('falls back to the bare address when the name is only whitespace', () => {
    const body = buildForwardBody({ ...source, from: { address: 'a@b.com', name: '  ' } });
    expect(body).toContain('From: a@b.com');
  });
});

describe('the subject', () => {
  it('gains one Fwd:', () => {
    expect(buildForwardSubject('Q3 report')).toBe('Fwd: Q3 report');
  });

  it('does not stack on one that already has it', () => {
    expect(buildForwardSubject('Fwd: Q3 report')).toBe('Fwd: Q3 report');
  });

  it('drops a reply prefix rather than keeping both', () => {
    expect(buildForwardSubject('Re: Q3 report')).toBe('Fwd: Q3 report');
  });
});
