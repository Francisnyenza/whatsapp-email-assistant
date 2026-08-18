import { describe, it, expect, vi } from 'vitest';
import { FolderService } from '../src/services/folder.service.js';

/**
 * Putting a message somewhere.
 *
 * The asymmetry with labels is the design, and it is worth stating: adding an
 * unknown *label* creates it, and moving to an unknown *folder* refuses. A label
 * leaves the message where it is, so a typo is visible and harmless. A move
 * takes it out of the inbox — putting it in a folder that did not exist a second
 * ago means the user cannot find it in the folder list they know, and as far as
 * they can tell the mail is gone.
 */

const FOLDERS = [
  { id: 'f-inbox', name: 'Inbox', isSystem: true },
  { id: 'f-archive', name: 'Archive', isSystem: true },
  { id: 'f-projects', name: 'Projects', isSystem: false },
  { id: 'f-clients-2026', name: 'Clients/2026', isSystem: false },
];

describe('moving', () => {
  it('sends the destination id, not the name', async () => {
    const { service, mailbox } = build();

    await service.move('user-1', 'email-1', 'Projects');

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'move',
      destinationId: 'f-projects',
    });
  });

  it('matches case-insensitively', async () => {
    const { service, mailbox } = build();

    await service.move('user-1', 'email-1', 'projects');

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'move',
      destinationId: 'f-projects',
    });
  });

  it('takes a system folder, which is an ordinary destination', async () => {
    // Unlike a system *label*: "move it to Archive" is a normal request, while
    // "label it as Trash" would be deleting by a route with no confirmation.
    const { service, mailbox } = build();

    await service.move('user-1', 'email-1', 'Archive');

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'move',
      destinationId: 'f-archive',
    });
  });

  it('takes a nested folder by its last segment when only one answers to it', async () => {
    const { service, mailbox } = build();

    await service.move('user-1', 'email-1', '2026');

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', {
      kind: 'move',
      destinationId: 'f-clients-2026',
    });
  });

  it('refuses a last segment two folders share', async () => {
    // "Clients/2026" and "Suppliers/2026" are different places, and picking one
    // puts the mail somewhere the user did not mean.
    const { service, mailbox } = build([
      ...FOLDERS,
      { id: 'f-suppliers-2026', name: 'Suppliers/2026', isSystem: false },
    ]);

    await expect(service.move('user-1', 'email-1', '2026')).rejects.toThrow();
    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('reports the destination as the mailbox spells it', async () => {
    const { service } = build();

    expect(await service.move('user-1', 'email-1', 'projects')).toBe('Projects');
  });
});

describe('a folder that does not exist', () => {
  it('refuses, and names the ones that do', async () => {
    // Creating it would take the message out of the inbox and into a place the
    // user cannot find in the folder list they know.
    const { service, mailbox } = build();

    await expect(service.move('user-1', 'email-1', 'Projekts')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('Projects'),
    });
    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('says so plainly when the mailbox has none at all', async () => {
    const { service } = build([]);

    await expect(service.move('user-1', 'email-1', 'Projects')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('any folders'),
    });
  });
});

describe('which mailbox the folder belongs to', () => {
  it('resolves against the account the message is in, not the primary', async () => {
    const { service, accounts } = build(FOLDERS, { messageAccountId: 'account-2' });

    await service.move('user-1', 'email-1', 'Projects');

    expect(accounts.load).toHaveBeenCalledWith('user-1', 'account-2');
    expect(accounts.loadPrimary).not.toHaveBeenCalled();
  });
});

describe('listing them', () => {
  it('sorts by name', async () => {
    const { service } = build();

    expect(await service.list('user-1')).toEqual(['Archive', 'Clients/2026', 'Inbox', 'Projects']);
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(
  folders: Array<{ id: string; name: string; isSystem: boolean }> = FOLDERS,
  options: { messageAccountId?: string } = {},
) {
  const provider = { listFolders: vi.fn(async () => folders) };

  const accounts = {
    load: vi.fn(async (_u: string, id: string) => ({ id, provider: 'outlook' })),
    loadPrimary: vi.fn(async () => ({ id: 'account-1', provider: 'outlook' })),
    providerFor: () => provider,
  };

  const mailbox = { apply: vi.fn(async () => undefined) };

  const prisma = {
    forUser: async <T>(_u: string, fn: (tx: unknown) => Promise<T>) =>
      fn({
        emailMessage: {
          findUnique: async () => ({
            accountId: options.messageAccountId ?? 'account-1',
            deletedAt: null,
          }),
        },
      }),
  };

  const service = new FolderService(
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
