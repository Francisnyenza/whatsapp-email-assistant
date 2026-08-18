import { describe, it, expect, vi } from 'vitest';
import { UndoService, inverseOf, UNDO_WINDOW_MS } from '../src/services/undo.service.js';

/**
 * Taking back the last thing you did.
 *
 * Two assertions here carry the design. The record is cleared on read, because
 * "undo, undo" applying the inverse of the inverse would archive the message it
 * had just brought back. And something that cannot be taken back says so by
 * name — "nothing to undo" a second after sending reads as a bug, and leaves the
 * user wondering whether the mail went at all.
 */

describe('what reverses what', () => {
  it('pairs each operation with its opposite', () => {
    expect(inverseOf({ kind: 'archive' })).toEqual({ kind: 'unarchive' });
    expect(inverseOf({ kind: 'unarchive' })).toEqual({ kind: 'archive' });
    expect(inverseOf({ kind: 'delete', permanent: false })).toEqual({ kind: 'restore' });
    expect(inverseOf({ kind: 'markRead', read: true })).toEqual({ kind: 'markRead', read: false });
    expect(inverseOf({ kind: 'star', starred: true })).toEqual({ kind: 'star', starred: false });
    expect(inverseOf({ kind: 'spam', isSpam: true })).toEqual({ kind: 'spam', isSpam: false });
  });

  it('refuses to invent an inverse for a permanent delete', () => {
    // Which is why nothing reachable from a chat performs one.
    expect(inverseOf({ kind: 'delete', permanent: true })).toBeNull();
  });

  it('leaves a label change to be undone by name', () => {
    // The ids came from a directory lookup; reversing them means resolving
    // against the same one, which this pure function cannot do.
    expect(inverseOf({ kind: 'label', add: ['Label_7'] })).toBeNull();
  });
});

describe('undoing', () => {
  it('applies the recorded inverse through the same path that acted', async () => {
    const { service, mailbox } = build({
      record: { emailMessageId: 'email-1', verb: 'archive', operation: { kind: 'unarchive' } },
    });

    const said = await service.undo('user-1');

    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', { kind: 'unarchive' });
    expect(said).toContain('inbox');
  });

  it('cancels the reminder and unarchives when the last thing was a snooze', async () => {
    const { service, mailbox, snoozes } = build({
      record: { emailMessageId: 'email-1', verb: 'snooze', snooze: true },
    });

    await service.undo('user-1');

    expect(snoozes.cancelFor).toHaveBeenCalledWith('user-1', 'email-1');
    expect(mailbox.apply).toHaveBeenCalledWith('user-1', 'email-1', { kind: 'unarchive' });
  });

  it('reverses a label change by name, through the label service', async () => {
    const { service, labels } = build({
      record: { emailMessageId: 'email-1', verb: 'label', labels: { remove: ['Receipts'] } },
    });

    await service.undo('user-1');

    expect(labels.apply).toHaveBeenCalledWith('user-1', 'email-1', { remove: ['Receipts'] });
  });

  it('says what cannot be taken back, rather than "nothing to undo"', async () => {
    // The message has already reached the recipient. Reporting an empty slot
    // here reads as a bug and leaves the user unsure the mail went.
    const { service, mailbox } = build({
      record: { emailMessageId: 'email-1', verb: 'reply', irreversible: true },
    });

    await expect(service.undo('user-1')).rejects.toMatchObject({
      publicMessage: expect.stringContaining("can't unsend"),
    });
    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('says plainly when there is nothing recorded', async () => {
    const { service } = build({ record: null });

    await expect(service.undo('user-1')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('nothing to undo'),
    });
  });

  it('refuses one that has gone stale', async () => {
    // A user saying "undo" an hour later almost certainly means something else,
    // and the mailbox has had a sync over it since.
    const stale = new Date(Date.now() - UNDO_WINDOW_MS - 1000).toISOString();
    const { service, mailbox } = build({
      record: { emailMessageId: 'email-1', verb: 'archive', operation: { kind: 'unarchive' } },
      at: stale,
    });

    await expect(service.undo('user-1')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('a while ago'),
    });
    expect(mailbox.apply).not.toHaveBeenCalled();
  });

  it('spends the record, so undoing twice does not redo', async () => {
    // The inverse of the inverse is the original action: without this, "undo,
    // undo" archives the message it had just brought back.
    const { service, inbox } = build({
      record: { emailMessageId: 'email-1', verb: 'archive', operation: { kind: 'unarchive' } },
    });

    await service.undo('user-1');

    expect(inbox.takeLastAction).toHaveBeenCalledTimes(1);
  });
});

describe('recording', () => {
  it('never fails the command it is recording for', async () => {
    // Losing the undo record costs an undo. Failing the archive costs the
    // archive.
    const { service } = build({ record: null, recordFails: true });

    await expect(
      service.record('user-1', { emailMessageId: 'email-1', verb: 'archive' }),
    ).resolves.toBeUndefined();
  });
});

/* --------------------------------- helpers -------------------------------- */

function build(input: {
  record: Record<string, unknown> | null;
  at?: string;
  recordFails?: boolean;
}) {
  const inbox = {
    setLastAction: vi.fn(async () => {
      if (input.recordFails) throw new Error('could not write');
    }),
    takeLastAction: vi.fn(async () =>
      input.record ? { ...input.record, at: input.at ?? new Date().toISOString() } : null,
    ),
  };

  const mailbox = { apply: vi.fn(async () => undefined) };
  const labels = { apply: vi.fn(async () => ({ added: [], removed: ['Receipts'] })) };
  const snoozes = { cancelFor: vi.fn(async () => 1) };

  const service = new UndoService(
    inbox as never,
    mailbox as never,
    labels as never,
    snoozes as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );

  return { service, inbox, mailbox, labels, snoozes };
}
