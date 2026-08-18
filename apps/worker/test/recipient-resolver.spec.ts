import { describe, it, expect, vi } from 'vitest';
import { RecipientResolverService } from '../src/services/recipient-resolver.service.js';

/**
 * Turning "sarah" into an address.
 *
 * The riskiest resolution in the product. Every other command acts on a message
 * the user was looking at, so a mistake is visible and reversible; this one
 * originates mail to somebody. The rules are deliberately unhelpful wherever
 * being helpful would be dangerous.
 */

describe('an address the user typed', () => {
  it('is passed through untouched', async () => {
    // Looking it up anyway risks "correcting" what they were explicit about.
    const { service, contacts } = build([]);

    expect(await service.resolve('user-1', 'alice@acme.com')).toBe('alice@acme.com');
    expect(contacts.findByName).not.toHaveBeenCalled();
  });

  it('is passed through as a list', async () => {
    const { service } = build([]);

    expect(await service.resolve('user-1', 'a@x.com, b@x.com')).toBe('a@x.com, b@x.com');
  });
});

describe('a name', () => {
  it('resolves when exactly one person answers to it', async () => {
    const { service } = build([{ emailAddress: 'sarah@acme.com', displayName: 'Sarah Chen' }]);

    expect(await service.resolve('user-1', 'sarah')).toBe('sarah@acme.com');
  });

  it('refuses when two people do, and names them', async () => {
    // Ranking two Sarahs by who writes more often is a guess wearing a
    // ranking's clothes.
    const { service } = build([
      { emailAddress: 'sarah.chen@acme.com', displayName: 'Sarah Chen' },
      { emailAddress: 'sarah.p@partner.com', displayName: 'Sarah Patel' },
    ]);

    await expect(service.resolve('user-1', 'sarah')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('sarah.p@partner.com'),
    });
  });

  it('refuses when nobody does, rather than sending to a near-miss', async () => {
    const { service } = build([]);

    await expect(service.resolve('user-1', 'sarah')).rejects.toMatchObject({
      publicMessage: expect.stringContaining("don't have an address"),
    });
  });

  it('refuses a list mixing names and addresses', async () => {
    const { service } = build([]);

    await expect(service.resolve('user-1', 'sarah, bob@x.com')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('one name at a time'),
    });
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(matches: Array<{ emailAddress: string; displayName: string | null }>) {
  const contacts = {
    findByName: vi.fn(async () => matches.map((m) => ({ ...m, messagesReceived: 1 }))),
  };

  return { service: new RecipientResolverService(contacts as never), contacts };
}
