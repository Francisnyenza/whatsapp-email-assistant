import { describe, it, expect, vi } from 'vitest';
import { GmailProvider } from '../src/providers/gmail.provider.js';

/**
 * Gmail's label directory.
 *
 * One assertion here matters more than the rest: system labels are excluded.
 * `users.labels.list` returns INBOX, SENT, SPAM, TRASH, DRAFT and the category
 * tabs alongside the user's own, and none of them are things anyone files mail
 * under by name. Offering them would let "label this as trash" delete a message
 * through a route with no confirmation — and "remove the inbox label" archive
 * one while claiming to have unfiled it.
 *
 * The client is stubbed by replacing the private accessor. There is no
 * constructor seam for it, and adding one only to observe two calls would widen
 * the adapter's surface for the sake of a test.
 */

describe('listing Gmail labels', () => {
  it('returns only the user’s own, with their ids', async () => {
    const { provider } = build({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'TRASH', name: 'TRASH', type: 'system' },
        { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS', type: 'system' },
        { id: 'Label_7', name: 'Receipts', type: 'user' },
        { id: 'Label_8', name: 'Travel', type: 'user' },
      ],
    });

    expect(await provider.listLabels(account())).toEqual([
      { id: 'Label_7', name: 'Receipts' },
      { id: 'Label_8', name: 'Travel' },
    ]);
  });

  it('skips a label with no id, which cannot be applied', async () => {
    const { provider } = build({ labels: [{ name: 'Broken', type: 'user' }] });

    expect(await provider.listLabels(account())).toEqual([]);
  });

  it('returns nothing rather than throwing for a mailbox with no labels', async () => {
    const { provider } = build({ labels: undefined });

    expect(await provider.listLabels(account())).toEqual([]);
  });
});

describe('creating a Gmail label', () => {
  it('makes it visible in the mailbox and in message lists', async () => {
    // Both default to hidden, which produces a label the user cannot find —
    // indistinguishable, to them, from the creation having failed.
    const { provider, created } = build({ labels: [] });

    const label = await provider.createLabel(account(), 'Tax 2026');

    expect(created.mock.calls[0]![0].requestBody).toMatchObject({
      name: 'Tax 2026',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    expect(label).toEqual({ id: 'Label_new', name: 'Tax 2026' });
  });

  it('raises rather than returning a label with no id', async () => {
    const { provider } = build({ labels: [], createReturnsId: false });

    await expect(provider.createLabel(account(), 'Tax')).rejects.toThrow();
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(input: {
  labels: Array<{ id?: string; name?: string; type?: string }> | undefined;
  createReturnsId?: boolean;
}) {
  const created = vi.fn(async (args: { requestBody: { name: string } }) => ({
    data:
      input.createReturnsId === false
        ? { name: args.requestBody.name }
        : { id: 'Label_new', name: args.requestBody.name },
  }));

  const provider = new GmailProvider({
    clientId: 'app',
    clientSecret: 'secret',
    redirectUri: 'https://example.com/cb',
  });

  Object.assign(provider, {
    client: () => ({
      users: {
        labels: {
          list: async () => ({ data: { labels: input.labels } }),
          create: created,
        },
      },
    }),
  });

  return { provider, created };
}

function account() {
  return {
    id: 'account-1',
    userId: 'user-1',
    provider: 'gmail',
    emailAddress: 'me@example.com',
    accessToken: 'token',
  };
}

describe('Gmail folders', () => {
  it('is the label list again, because Gmail has no folders', async () => {
    // System labels are *included* here where `listLabels` drops them, and the
    // difference is the point: "move it to Archive" is an ordinary request,
    // while "label it as Trash" is deleting a message by a route with no
    // confirmation.
    const { provider } = build({
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'Label_7', name: 'Receipts', type: 'user' },
      ],
    });

    expect(await provider.listFolders(account())).toEqual([
      { id: 'INBOX', name: 'INBOX', isSystem: true },
      { id: 'Label_7', name: 'Receipts', isSystem: false },
    ]);
  });

  it('never offers Trash or Spam as a destination', async () => {
    // Both are reachable by their own verb, which asks first.
    const { provider } = build({
      labels: [
        { id: 'TRASH', name: 'TRASH', type: 'system' },
        { id: 'SPAM', name: 'SPAM', type: 'system' },
        { id: 'Label_7', name: 'Receipts', type: 'user' },
      ],
    });

    expect(await provider.listFolders(account())).toEqual([
      { id: 'Label_7', name: 'Receipts', isSystem: false },
    ]);
  });
});
