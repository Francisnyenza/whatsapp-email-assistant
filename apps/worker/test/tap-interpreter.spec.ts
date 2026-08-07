import { describe, it, expect } from 'vitest';
import type { ActionPayload, PayloadAction } from '@wea/shared';
import { interpretTap } from '../src/services/tap-interpreter.js';
import { YES_BODY, NO_BODY } from '../src/services/canned-replies.js';

/**
 * What a button press means.
 *
 * The distinction this file exists to protect is between a verb and its
 * confirmation. Getting it wrong deletes someone's mail on a mis-tap.
 */

const tap = (action: PayloadAction, arg?: string): ActionPayload => ({
  action,
  targetId: 'email-1',
  ...(arg ? { arg } : {}),
});

describe('destructive verbs', () => {
  it('asks rather than deleting when the card button is tapped', () => {
    // This button sits on every notification. A fat-fingered tap must cost
    // nothing.
    expect(interpretTap(tap('delete'))).toEqual({ kind: 'confirm', verb: 'delete' });
  });

  it('deletes only on the confirmation button', () => {
    const effect = interpretTap(tap('confirm_delete'));

    expect(effect.kind).toBe('mutate');
    expect(effect).toMatchObject({ operation: { kind: 'delete', permanent: false } });
  });

  it('never deletes permanently', () => {
    // The user authorized "delete", which in every mail client means the trash.
    // Bypassing it would be a harsher operation than the one they asked for.
    const effect = interpretTap(tap('confirm_delete'));
    expect(effect).toMatchObject({ operation: { permanent: false } });
  });

  it('says so, so the user knows it is recoverable', () => {
    const effect = interpretTap(tap('confirm_delete'));
    expect(effect.kind === 'mutate' && effect.confirmation).toMatch(/trash/i);
  });
});

describe('reversible verbs act on the tap alone', () => {
  const cases: Array<[PayloadAction, unknown]> = [
    ['archive', { kind: 'archive' }],
    ['mark_read', { kind: 'markRead', read: true }],
    ['mark_important', { kind: 'star', starred: true }],
  ];

  for (const [action, operation] of cases) {
    it(`${action} maps to ${JSON.stringify(operation)}`, () => {
      expect(interpretTap(tap(action))).toMatchObject({ kind: 'mutate', operation });
    });
  }
});

describe('quick replies', () => {
  it('sends the same words as typing yes', () => {
    expect(interpretTap(tap('reply_yes'))).toEqual({ kind: 'reply', body: YES_BODY });
  });

  it('sends the same words as typing no', () => {
    expect(interpretTap(tap('reply_no'))).toEqual({ kind: 'reply', body: NO_BODY });
  });

  it('keeps them plain, because they go out as the user’s own words', () => {
    for (const body of [YES_BODY, NO_BODY]) {
      expect(body).not.toMatch(/whatsapp|assistant|sent from|🤖/i);
    }
  });

  it('asks for text when the reply button is tapped', () => {
    expect(interpretTap(tap('reply'))).toEqual({ kind: 'await_reply_text' });
  });
});

describe('everything else', () => {
  it('cancel does nothing and says so', () => {
    expect(interpretTap(tap('cancel'))).toMatchObject({ kind: 'acknowledge' });
  });

  it('routes the forward confirmation to the pending action, not the button', () => {
    // The effect carries no recipient. It cannot: an address arriving with the
    // tap would be an address an attacker could choose.
    const effect = interpretTap(tap('confirm_send'));

    expect(effect).toEqual({ kind: 'confirm_forward' });
    expect(JSON.stringify(effect)).not.toContain('@');
  });

  it('names the missing capability rather than going quiet', () => {
    // A button that does nothing at all reads as broken.
    for (const action of ['summarize', 'translate', 'read_aloud', 'forward', 'undo'] as const) {
      const effect = interpretTap(tap(action));
      expect(effect.kind).toBe('unavailable');
      expect(effect).toMatchObject({ capability: expect.stringMatching(/\w/) });
    }
  });

  it('never returns a mutation for a verb that is not a mutation', () => {
    for (const action of ['reply', 'cancel', 'open_thread', 'more', 'delete'] as const) {
      expect(interpretTap(tap(action)).kind).not.toBe('mutate');
    }
  });
});

describe('every action is handled', () => {
  it('covers the whole PayloadAction union', () => {
    // The interpreter's default branch is a `never` assertion, so an unhandled
    // action fails the build — but this also catches one handled with a
    // placeholder that was never revisited.
    const all: PayloadAction[] = [
      'reply',
      'reply_yes',
      'reply_no',
      'archive',
      'delete',
      'confirm_delete',
      'confirm_send',
      'forward',
      'summarize',
      'translate',
      'read_aloud',
      'mark_read',
      'mark_important',
      'open_thread',
      'cancel',
      'undo',
      'more',
    ];

    for (const action of all) {
      expect(interpretTap(tap(action)).kind, `${action} has no effect`).toBeTruthy();
    }
  });
});
