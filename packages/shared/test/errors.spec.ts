import { describe, it, expect } from 'vitest';
import { AppError } from '../src/errors/app-error.js';

/**
 * The line between the two audiences.
 *
 * `message` is for logs and engineers; `publicMessage` is what a person reads.
 * The third fact — whether that public message was written for *this* failure or
 * defaulted from the code — is what lets a layer with its own phrasing know when
 * to defer.
 */

describe('a public message written for one failure', () => {
  it('is distinguishable from the code’s default', () => {
    // The distinction a layer with its own phrasing per code needs: the command
    // processor turns NOT_FOUND into "I couldn't find that email any more",
    // which is right for a missing message and wrong for a missing label.
    const specific = new AppError('NOT_FOUND', 'no such label', {
      publicMessage: 'You don’t have a label called “Recipts”.',
    });
    const defaulted = new AppError('NOT_FOUND', 'no such message');

    expect(specific.hasSpecificPublicMessage).toBe(true);
    expect(defaulted.hasSpecificPublicMessage).toBe(false);
  });

  it('still leaves every error with something safe to show', () => {
    for (const code of ['NOT_FOUND', 'PROVIDER_ERROR', 'INTERNAL'] as const) {
      const error = new AppError(code, 'internal detail naming account 7f3a');

      expect(error.publicMessage.length).toBeGreaterThan(0);
      // The engineer's message must never be the one a user sees.
      expect(error.publicMessage).not.toContain('7f3a');
    }
  });

  it('keeps the engineer’s message separate from the user’s', () => {
    const error = new AppError('PROVIDER_ERROR', 'gmail returned 502 for account 7f3a', {
      publicMessage: 'Your mail provider had a problem. Try again in a moment.',
    });

    expect(error.message).toContain('7f3a');
    expect(error.publicMessage).not.toContain('7f3a');
  });
});
