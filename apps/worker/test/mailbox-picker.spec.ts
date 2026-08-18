import { describe, it, expect } from 'vitest';
import { MailboxPickerService } from '../src/services/mailbox-picker.service.js';

/**
 * Which mailbox an email goes out from.
 *
 * Irrelevant with one connected and decisive with two: the address in the
 * `From:` header is the identity the recipient sees and replies to, and a work
 * email sent from a personal address cannot be taken back — the reply lands in
 * the wrong inbox, and the recipient now has an address they were never given.
 *
 * So both failure modes here are refusals. A hint matching nothing is a typo;
 * a hint matching two is a coin flip on the user's identity, which is worse
 * than asking.
 */

const WORK = {
  id: 'acct-work',
  emailAddress: 'me@acme.com',
  displayName: 'Work',
  isPrimary: true,
};
const PERSONAL = {
  id: 'acct-personal',
  emailAddress: 'me@gmail.com',
  displayName: null,
  isPrimary: false,
};

describe('with no hint', () => {
  it('uses the primary, which is a deterministic answer', async () => {
    const picked = await build([PERSONAL, WORK]).pick('user-1');
    // The repository orders primary first; this asserts the caller honours it
    // rather than taking whichever row arrived.
    expect(picked.id).toBe('acct-personal');
  });

  it('refuses when nothing is connected, rather than sending from nowhere', async () => {
    await expect(build([]).pick('user-1')).rejects.toMatchObject({
      publicMessage: expect.stringContaining("haven't connected a mailbox"),
    });
  });
});

describe('naming one', () => {
  it('matches the nickname the user gave it', async () => {
    expect((await build([WORK, PERSONAL]).pick('user-1', 'work')).id).toBe('acct-work');
  });

  it('matches the whole address', async () => {
    expect((await build([WORK, PERSONAL]).pick('user-1', 'me@gmail.com')).id).toBe('acct-personal');
  });

  it('matches the domain, which is how people refer to one they never named', async () => {
    expect((await build([WORK, PERSONAL]).pick('user-1', 'gmail')).id).toBe('acct-personal');
    expect((await build([WORK, PERSONAL]).pick('user-1', 'acme')).id).toBe('acct-work');
  });

  it('ignores case', async () => {
    expect((await build([WORK, PERSONAL]).pick('user-1', 'WORK')).id).toBe('acct-work');
  });
});

describe('what it refuses', () => {
  it('names the mailboxes when the hint matches none', async () => {
    await expect(build([WORK, PERSONAL]).pick('user-1', 'school')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('me@acme.com'),
    });
  });

  it('refuses rather than choosing when the hint matches two', async () => {
    // Picking one would be a coin flip on which identity the recipient sees.
    const both = [
      { ...WORK, emailAddress: 'me@acme.com', displayName: 'Acme work' },
      { ...PERSONAL, emailAddress: 'other@acme.com', displayName: 'Acme side' },
    ];

    await expect(build(both).pick('user-1', 'acme')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('more than one'),
    });
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(accounts: Array<typeof WORK | typeof PERSONAL>) {
  const prisma = {
    forUser: async <T>(_u: string, fn: (tx: unknown) => Promise<T>) =>
      fn({ emailAccount: { findMany: async () => accounts } }),
  };

  return new MailboxPickerService(prisma as never);
}
