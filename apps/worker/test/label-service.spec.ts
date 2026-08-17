import { describe, it, expect, vi } from 'vitest';
import { LabelService } from '../src/services/label.service.js';

/**
 * Filing mail under a name.
 *
 * The `label` operation has been implemented in both adapters since Phase 7.
 * What was missing is the translation, and it is the whole substance of this
 * class: Gmail's `addLabelIds` takes ids and ignores names, Outlook's
 * categories *are* names. A command that passed the user's words straight
 * through would work against one mailbox and silently do nothing against the
 * other — while reporting success, which is the worst of the three outcomes.
 */

describe('filing under an existing label', () => {
  it('sends the id, not the name', async () => {
    // Against Gmail a name here is accepted and does nothing at all.
    const { service, mailbox } = build({ existing: [{ id: 'Label_7', name: 'Receipts' }] });

    await service.apply('user-1', 'email-1', { add: ['Receipts'] });

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'label',
      add: ['Label_7'],
    });
  });

  it('matches case-insensitively rather than making a second label', async () => {
    const { service, provider, mailbox } = build({
      existing: [{ id: 'Label_7', name: 'Receipts' }],
    });

    const result = await service.apply('user-1', 'email-1', { add: ['receipts'] });

    expect(provider.createLabel).not.toHaveBeenCalled();
    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'label',
      add: ['Label_7'],
    });
    // Reported as the mailbox spells it: the user's next command is typed from
    // what they read.
    expect(result.added).toEqual(['Receipts']);
  });
});

describe('filing under one that does not exist', () => {
  it('creates it, because every mail client does', async () => {
    const { service, provider, mailbox } = build({ existing: [] });

    await service.apply('user-1', 'email-1', { add: ['Tax 2026'] });

    expect(provider.createLabel).toHaveBeenCalledWith(expect.anything(), 'Tax 2026');
    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'label',
      add: ['created-Tax 2026'],
    });
  });

  it('creates it once when it is named twice', async () => {
    const { service, provider } = build({ existing: [] });

    await service.apply('user-1', 'email-1', { add: ['Tax', 'tax'] });

    expect(provider.createLabel).toHaveBeenCalledTimes(1);
  });
});

describe('taking a label off', () => {
  it('refuses one the mailbox does not have, and says which it does', async () => {
    // A remove that silently succeeds is a claim that something was unfiled
    // when nothing was.
    const { service, mailbox } = build({
      existing: [
        { id: 'Label_7', name: 'Receipts' },
        { id: 'Label_8', name: 'Travel' },
      ],
    });

    await expect(service.apply('user-1', 'email-1', { remove: ['Recipts'] })).rejects.toMatchObject(
      { publicMessage: expect.stringContaining('Receipts, Travel') },
    );

    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('does not create one on the way to removing it', async () => {
    const { service, provider } = build({ existing: [] });

    await expect(service.apply('user-1', 'email-1', { remove: ['Ghost'] })).rejects.toThrow();

    expect(provider.createLabel).not.toHaveBeenCalled();
  });

  it('sends the id for one that exists', async () => {
    const { service, mailbox } = build({ existing: [{ id: 'Label_7', name: 'Receipts' }] });

    await service.apply('user-1', 'email-1', { remove: ['Receipts'] });

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'label',
      remove: ['Label_7'],
    });
  });
});

describe('which mailbox the label belongs to', () => {
  it('resolves against the account the message is in, not the primary', async () => {
    // A user with Gmail and Outlook connected has two disjoint label sets.
    // Filing a Graph message under a Gmail label id is meaningless.
    const { service, accounts } = build({ existing: [], messageAccountId: 'account-2' });

    await service.apply('user-1', 'email-1', { add: ['Receipts'] });

    expect(accounts.load).toHaveBeenCalledWith('user-1', 'account-2');
    expect(accounts.loadPrimary).not.toHaveBeenCalled();
  });

  it('refuses when the message is gone', async () => {
    const { service, mailbox } = build({ existing: [], message: null });

    await expect(service.apply('user-1', 'email-1', { add: ['Receipts'] })).rejects.toThrow();

    expect(mailbox.apply).not.toHaveBeenCalled();
  });
});

describe('asking what labels exist', () => {
  it('lists them alphabetically', async () => {
    const { service } = build({
      existing: [
        { id: '2', name: 'Travel' },
        { id: '1', name: 'Receipts' },
      ],
    });

    expect(await service.list('user-1')).toEqual(['Receipts', 'Travel']);
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(input: {
  existing: Array<{ id: string; name: string }>;
  messageAccountId?: string;
  message?: null;
}) {
  const provider = {
    listLabels: vi.fn(async () => input.existing),
    createLabel: vi.fn(async (_a: unknown, name: string) => ({ id: `created-${name}`, name })),
  };

  const accounts = {
    load: vi.fn(async (_u: string, id: string) => ({ id, provider: 'gmail' })),
    loadPrimary: vi.fn(async () => ({ id: 'account-1', provider: 'gmail' })),
    providerFor: () => provider,
  };

  const mailbox = { apply: vi.fn(async () => undefined) };

  const prisma = {
    forUser: async <T>(_u: string, fn: (tx: unknown) => Promise<T>) =>
      fn({
        emailMessage: {
          findUnique: async () =>
            input.message === null
              ? null
              : { accountId: input.messageAccountId ?? 'account-1', deletedAt: null },
        },
      }),
  };

  const service = new LabelService(
    prisma as never,
    accounts as never,
    mailbox as never,
    {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
  );

  return { service, provider, accounts, mailbox };
}
