import { describe, it, expect } from 'vitest';
import { redact, redactString, maskEmail, maskPhone, fingerprint } from '../src/utils/redact.js';

describe('redaction', () => {
  it('masks an email address but keeps the domain readable', () => {
    expect(maskEmail('sarah.chen@example.com')).toBe('s***n@example.com');
    expect(maskEmail('jo@example.com')).toBe('j***@example.com');
    expect(maskEmail('not-an-address')).toBe('[REDACTED]');
  });

  it('masks a phone number down to its last four digits', () => {
    expect(maskPhone('+254712345678')).toBe('+2547****5678');
    expect(maskPhone('123')).toBe('[REDACTED]');
  });

  it('masks addresses and numbers appearing inline in free text', () => {
    const out = redactString('Contact sarah.chen@example.com or +254712345678 today');
    expect(out).not.toContain('sarah.chen@example.com');
    expect(out).not.toContain('712345678');
    expect(out).toContain('example.com');
  });

  it('strips every secret-shaped key', () => {
    const out = redact({
      accessToken: 'ya29.super-secret',
      refreshToken: 'rt-secret',
      password: 'hunter2',
      apiKey: 'sk-live-abc',
      authorization: 'Bearer abc',
      totpSecret: 'JBSWY3DPEH',
      ciphertext: 'AAAA',
      userId: 'user-1',
    }) as Record<string, unknown>;

    for (const key of [
      'accessToken',
      'refreshToken',
      'password',
      'apiKey',
      'authorization',
      'totpSecret',
      'ciphertext',
    ]) {
      expect(out[key], key).toBe('[REDACTED]');
    }
    // Non-sensitive identifiers survive, or the logs become useless.
    expect(out.userId).toBe('user-1');
  });

  it('replaces correspondence content with a stable fingerprint', () => {
    const body = 'Please send the Q3 report before Friday.';
    const out = redact({ bodyText: body }) as Record<string, string>;

    expect(out.bodyText).not.toContain('Q3');
    expect(out.bodyText).toContain(fingerprint(body));
    expect(out.bodyText).toContain(`len=${body.length}`);
    // Same content logged twice correlates, which is the point of hashing
    // rather than dropping it.
    expect(redact({ bodyText: body })).toEqual(out);
  });

  it('redacts a secret-named container whole, without descending into it', () => {
    // `tokens` matches a secret pattern, so the entire subtree goes — safer than
    // walking it and hoping every child key also matches.
    const out = redact({
      account: { provider: 'gmail', tokens: { accessToken: 'secret', expiresAt: 123 } },
    }) as any;

    expect(out.account.tokens).toBe('[REDACTED]');
    expect(out.account.provider).toBe('gmail');
  });

  it('redacts secrets nested under ordinary keys', () => {
    const out = redact({
      account: { provider: 'gmail', grant: { accessToken: 'secret', scope: 'gmail.readonly' } },
      messages: [{ subject: 'Invoice #42', from: 'billing@vendor.com' }],
    }) as any;

    expect(out.account.grant.accessToken).toBe('[REDACTED]');
    expect(out.account.grant.scope).toBe('gmail.readonly');
    expect(out.messages[0].subject).toMatch(/^\[content:/);
    // Addresses are masked wherever they appear, not only under *email* keys.
    expect(out.messages[0].from).toBe('b***g@vendor.com');
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect((redact(node) as any).self).toBe('[CIRCULAR]');
  });

  it('does not dump buffer contents', () => {
    const out = redact({ attachment: Buffer.from('binary content here') }) as any;
    expect(out.attachment).toBe('[buffer len=19]');
  });
});
