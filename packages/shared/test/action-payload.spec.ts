import { describe, it, expect } from 'vitest';
import {
  encodeActionPayload,
  decodeActionPayload,
  requiresConfirmation,
  MAX_PAYLOAD_LENGTH,
} from '../src/utils/action-payload.js';
import { AppError } from '../src/errors/app-error.js';

describe('action payload codec', () => {
  it('round-trips an action with a target', () => {
    const encoded = encodeActionPayload({ action: 'reply', targetId: 'abc123' });
    expect(encoded).toBe('act:reply:abc123');
    expect(decodeActionPayload(encoded)).toEqual({ action: 'reply', targetId: 'abc123' });
  });

  it('round-trips an action carrying an argument', () => {
    const encoded = encodeActionPayload({ action: 'translate', targetId: 'msg-1', arg: 'sw' });
    expect(decodeActionPayload(encoded)).toEqual({
      action: 'translate',
      targetId: 'msg-1',
      arg: 'sw',
    });
  });

  it('stays within WhatsApp id limits for a UUID target', () => {
    const uuid = '0b2f4c9e-5d31-4a7b-9f2e-8c1d6a3b7e50';
    expect(encodeActionPayload({ action: 'confirm_delete', targetId: uuid }).length).toBeLessThan(
      MAX_PAYLOAD_LENGTH,
    );
  });

  it('refuses to mint a payload for an unknown verb', () => {
    expect(() =>
      // @ts-expect-error deliberately invalid verb
      encodeActionPayload({ action: 'exfiltrate', targetId: 'abc' }),
    ).toThrow(AppError);
  });

  it('refuses target ids that are not our own record shape', () => {
    // The guard that keeps user- and email-controlled text out of button ids.
    for (const bad of ['a:b', '../etc/passwd', 'id with space', '<script>', '']) {
      expect(() => encodeActionPayload({ action: 'reply', targetId: bad })).toThrow(AppError);
    }
  });

  describe('decoding untrusted input', () => {
    // These arrive over the wire from Meta. A malformed one means "not our
    // button" — it must return null, never throw and never be trusted.
    const rejected = [
      '',
      'reply:abc',
      'act:reply',
      'act:reply:abc:extra:more',
      'evil:reply:abc',
      'act:unknown_verb:abc',
      'act:reply:../../etc/passwd',
      'act:reply:abc;DROP TABLE users',
      `act:reply:${'a'.repeat(300)}`,
    ];

    for (const input of rejected) {
      it(`rejects ${JSON.stringify(input.slice(0, 40))}`, () => {
        expect(decodeActionPayload(input)).toBeNull();
      });
    }
  });

  it('flags destructive verbs as needing confirmation', () => {
    expect(requiresConfirmation('delete')).toBe(true);
    expect(requiresConfirmation('forward')).toBe(true);
    expect(requiresConfirmation('archive')).toBe(false);
    expect(requiresConfirmation('reply')).toBe(false);
  });
});
