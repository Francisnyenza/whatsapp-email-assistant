import { describe, it, expect } from 'vitest';
import { ResponsePlanner, type PlanContext } from '../src/services/response-planner.js';
import type { Resolution } from '../src/services/thread-resolver.js';
import { decodeActionPayload, type CommandIntent } from '@wea/shared';

/**
 * What the assistant says back.
 *
 * Two invariants carry real weight here, and both are structural rather than
 * stylistic: a destructive verb must never produce a "done", and an unresolved
 * target must never produce silence. Everything else is manners — but manners
 * are most of what makes this feel like an assistant rather than a CLI.
 */

const planner = new ResponsePlanner();

const resolved = (id = 'email-1'): Resolution => ({
  outcome: 'resolved',
  emailMessageId: id,
  rank: 1,
  basis: 'replied directly to our notification',
});

const ambiguous = (n = 3): Resolution => ({
  outcome: 'ambiguous',
  options: Array.from({ length: n }, (_, i) => ({
    emailMessageId: `email-${i}`,
    fromAddress: `person${i}@acme.com`,
    fromName: `Person ${i}`,
    subject: `Subject ${i}`,
    receivedAt: new Date(),
  })),
  basis: 'nothing identified which email was meant',
});

const plan = (intent: CommandIntent, resolution: Resolution, over: Partial<PlanContext> = {}) =>
  planner.plan({
    intent,
    resolution,
    subject: 'Q3 sales report',
    looksLikeReplyBody: false,
    rawText: '',
    ...over,
  });

/**
 * Every payload kind exposes its text somewhere; this gathers all of it.
 * Accepts either a PlannedResponse or a bare payload.
 */
function textOf(input: any): string {
  const payload = input?.payload ?? input;
  return [payload.body, payload.header, payload.footer].filter(Boolean).join(' ');
}

describe('destructive verbs never report success', () => {
  // The structural half of ADR 0004: there is no branch that returns "deleted".

  it('turns delete into a confirmation bound to the resolved email', () => {
    const result = plan({ intent: 'delete' }, resolved('email-9'));

    expect(result.followUp).toBe('await_confirmation');

    const confirm = (result.payload as any).buttons.find(
      (b: any) => decodeActionPayload(b.id)?.action === 'confirm_delete',
    );
    expect(decodeActionPayload(confirm.id)?.targetId).toBe('email-9');
  });

  it('never says the email was deleted', () => {
    const text = textOf(plan({ intent: 'delete' }, resolved())).toLowerCase();
    expect(text).not.toContain('deleted');
    expect(text).toContain('?');
  });

  it('turns forward into a confirmation naming the recipient', () => {
    const result = plan({ intent: 'forward', recipient: 'accounts@acme.com' }, resolved('email-3'));

    expect(result.followUp).toBe('await_confirmation');
    expect(textOf(result.payload)).toContain('accounts@acme.com');
    expect(textOf(result.payload).toLowerCase()).not.toContain('forwarded');
  });

  it('offers a way out of every confirmation', () => {
    for (const intent of [
      { intent: 'delete' } as const,
      { intent: 'forward', recipient: 'x@y.com' } as const,
    ]) {
      const actions = (plan(intent, resolved()).payload as any).buttons.map(
        (b: any) => decodeActionPayload(b.id)?.action,
      );
      expect(actions.some((a: string) => a === 'cancel' || a === 'confirm_delete')).toBe(true);
    }
  });
});

describe('an unidentified target always produces a question', () => {
  // Silence is the one response users read as "it's broken".

  it('offers a pickable list when several emails could be meant', () => {
    const result = plan({ intent: 'reply' }, ambiguous(3));

    expect(result.followUp).toBe('await_confirmation');
    expect((result.payload as any).sections[0].rows).toHaveLength(3);
  });

  it('makes each option resolve to exactly one email', () => {
    const rows = (plan({ intent: 'reply' }, ambiguous(3)).payload as any).sections[0].rows;
    for (const row of rows) {
      expect(decodeActionPayload(row.id)?.targetId).toMatch(/^email-\d$/);
    }
  });

  it('explains a named person we could not find, by name', () => {
    const result = plan(
      { intent: 'reply', target: 'Priya' },
      {
        outcome: 'none',
        basis: 'no recent email from "Priya"',
      },
    );

    expect(textOf(result.payload)).toContain('Priya');
  });

  it('tells the user how to disambiguate rather than just failing', () => {
    const result = plan({ intent: 'reply' }, { outcome: 'none', basis: 'no recent emails' });
    expect(textOf(result.payload).toLowerCase()).toContain('reply directly');
  });

  it('never returns an empty payload', () => {
    const cases: Array<[CommandIntent, Resolution]> = [
      [{ intent: 'reply' }, ambiguous()],
      [{ intent: 'delete' }, { outcome: 'none', basis: 'x' }],
      [{ intent: 'archive' }, ambiguous()],
      [
        { intent: 'unknown', raw: 'zzz' },
        { outcome: 'none', basis: 'x' },
      ],
    ];

    for (const [intent, resolution] of cases) {
      expect(textOf(plan(intent, resolution)).length, intent.intent).toBeGreaterThan(0);
    }
  });
});

describe('replying', () => {
  it('queues the send when the body was given inline', () => {
    const result = plan({ intent: 'reply', body: 'On it' }, resolved());
    expect(result.followUp).toBe('queue_send');
  });

  it('asks for the text when only the target was given', () => {
    const result = plan({ intent: 'reply' }, resolved());
    expect(result.followUp).toBe('await_reply_text');
    expect(textOf(result.payload)).toContain('Q3 sales report');
  });

  it('treats a bare yes as a reply to the email in context', () => {
    expect(plan({ intent: 'reply_affirmative' }, resolved()).followUp).toBe('queue_send');
  });

  it('treats dictated prose as reply text when a thread is in context', () => {
    const result = plan({ intent: 'unknown', raw: 'Sounds good, Friday works' }, resolved(), {
      looksLikeReplyBody: true,
    });
    expect(result.followUp).toBe('queue_send');
  });

  it('asks rather than sending when prose has no thread in context', () => {
    const result = plan({ intent: 'unknown', raw: 'hmm' }, resolved(), {
      looksLikeReplyBody: false,
    });
    expect(result.followUp).toBe('none');
    expect(textOf(result.payload)).toContain('reply');
  });
});

describe('reversible actions happen without a confirmation', () => {
  it('archives directly', () => {
    const result = plan({ intent: 'archive' }, resolved());
    expect(result.followUp).toBe('queue_action');
    expect(textOf(result.payload)).toContain('Archived');
  });

  it('distinguishes read from unread in the acknowledgement', () => {
    expect(textOf(plan({ intent: 'mark_read', read: true }, resolved()))).toContain('read');
    expect(textOf(plan({ intent: 'mark_read', read: false }, resolved()))).toContain('unread');
  });
});

describe('unbuilt features say so plainly', () => {
  // An assistant that goes quiet reads as broken. Naming the specific missing
  // capability is more useful than a generic apology.

  it('does not apologise, blame the user, or hedge', () => {
    const text = textOf(plan({ intent: 'summarize' }, resolved())).toLowerCase();
    for (const word of ['sorry', 'unfortunately', 'oops', 'invalid']) {
      expect(text, word).not.toContain(word);
    }
  });
});

describe('reading an email aloud', () => {
  it('plans the speech effect against the resolved email', () => {
    const planned = plan({ intent: 'read_aloud' }, resolved());

    expect(planned.effect).toEqual({ kind: 'speak' });
    expect(planned.emailMessageId).toBeDefined();
  });

  it('carries the placeholder the processor is meant to discard', () => {
    // Same contract as summarise: the answer *is* the message, so this text is
    // never sent. `queue_query` rather than `queue_action` is what tells the
    // processor which of the two it is holding — get that wrong and a voice
    // note arrives as the word "Recording…".
    const planned = plan({ intent: 'read_aloud' }, resolved());

    expect(planned.followUp).toBe('queue_query');
    expect(textOf(planned)).toContain('Recording');
  });

  it('asks which email rather than picking one when the target is ambiguous', () => {
    // An effect without a resolved id would reach `carryOutPlan` with nothing
    // to act on, and reading the wrong email aloud is not recoverable by the
    // listener having heard it.
    const planned = plan({ intent: 'read_aloud' }, ambiguous());

    expect(planned.effect).toBeUndefined();
  });
});

describe('the intents this class deliberately does not own', () => {
  // `question`, `search` and the standing lists are reads over the whole
  // mailbox, answered by MailboxQueryService before the planner is reached —
  // this class has no database and grows none to serve them.

  it('carries out nothing for a mailbox-wide read', () => {
    // The property that matters if the interception upstream is ever removed:
    // reaching here produces no effect, so nothing is executed against a
    // half-understood intent. The user gets the fallback instead, which is
    // visibly wrong rather than quietly wrong.
    for (const intent of [
      { intent: 'question' as const, question: 'did tom reply?' },
      { intent: 'search' as const, query: 'invoices' },
      { intent: 'list_unread' as const },
      { intent: 'list_deadlines' as const },
    ]) {
      const planned = plan(intent, resolved());

      expect(planned.effect, intent.intent).toBeUndefined();
      expect(planned.followUp, intent.intent).toBe('none');
    }
  });

  it('still says something, because silence reads as broken', () => {
    expect(
      textOf(plan({ intent: 'question', question: 'anything?' }, resolved())).length,
    ).toBeGreaterThan(0);
  });
});

describe('commands that need no email at all', () => {
  const nowhere: Resolution = { outcome: 'none', basis: 'no recent emails to reply to' };

  it('answers help even with an empty mailbox', () => {
    const text = textOf(plan({ intent: 'help' }, nowhere));
    expect(text).toContain('reply');
    expect(text).toContain('archive');
    // The product promise, restated where a new user will actually read it.
    expect(text.toLowerCase()).toContain('own email address');
  });

  it('confirms a cancel without needing a target', () => {
    const result = plan({ intent: 'cancel' }, nowhere);
    expect(textOf(result.payload)).toContain('Cancelled');
    expect(result.followUp).toBe('none');
  });

  it('makes clear a cancel sent nothing', () => {
    expect(textOf(plan({ intent: 'cancel' }, nowhere))).toContain('Nothing was sent');
  });
});

describe('payloads stay inside WhatsApp limits', () => {
  it('clamps a long subject in a confirmation', () => {
    const result = plan({ intent: 'delete' }, resolved(), { subject: 'x'.repeat(5000) });
    expect((result.payload as any).body.length).toBeLessThanOrEqual(1024);
  });

  it('caps a disambiguation list at ten rows', () => {
    const result = plan({ intent: 'reply' }, ambiguous(30));
    expect((result.payload as any).sections[0].rows.length).toBeLessThanOrEqual(10);
  });
});

describe('what it says matches what it does', () => {
  /**
   * `followUp` describes the plan and `effect` carries it out. They are written
   * side by side in every branch, so they can drift — and drift here means a
   * message saying "Archived." with nothing to archive, or an effect fired for a
   * plan that was only meant to ask.
   */
  const everyPlan: Array<[string, ReturnType<typeof plan>]> = [
    ['reply with body', plan({ intent: 'reply', body: 'On Friday' }, resolved())],
    ['reply without body', plan({ intent: 'reply' }, resolved())],
    ['yes', plan({ intent: 'reply_affirmative' }, resolved())],
    ['no', plan({ intent: 'reply_negative' }, resolved())],
    ['archive', plan({ intent: 'archive' }, resolved())],
    ['mark read', plan({ intent: 'mark_read', read: true }, resolved())],
    ['mark unread', plan({ intent: 'mark_read', read: false }, resolved())],
    ['star', plan({ intent: 'mark_important', important: true }, resolved())],
    ['delete', plan({ intent: 'delete' }, resolved())],
    ['help', plan({ intent: 'help' }, resolved())],
    ['unknown', plan({ intent: 'unknown', raw: 'zzz' }, resolved())],
    [
      'prose as a reply',
      plan({ intent: 'unknown', raw: 'sounds good' }, resolved(), {
        looksLikeReplyBody: true,
        rawText: 'sounds good',
      }),
    ],
  ];

  for (const [label, result] of everyPlan) {
    it(`${label}: an effect appears exactly when the plan is to act`, () => {
      const shouldAct = result.followUp === 'queue_send' || result.followUp === 'queue_action';
      expect(Boolean(result.effect), `followUp=${result.followUp}`).toBe(shouldAct);
    });
  }

  it('queue_send always carries something to say', () => {
    // An empty body would be a blank email sent under the user's name.
    for (const [label, result] of everyPlan) {
      if (result.followUp !== 'queue_send') continue;
      expect(result.effect, label).toMatchObject({ kind: 'reply' });
      expect((result.effect as { body: string }).body.trim().length, label).toBeGreaterThan(0);
    }
  });

  it('queue_action always carries a mailbox operation', () => {
    for (const [label, result] of everyPlan) {
      if (result.followUp !== 'queue_action') continue;
      expect(result.effect, label).toMatchObject({ kind: 'mutate' });
    }
  });

  it('a destructive verb never carries an effect', () => {
    // The one that would delete someone's mail without asking.
    expect(plan({ intent: 'delete' }, resolved()).effect).toBeUndefined();
    expect(plan({ intent: 'forward', recipient: 'x@y.com' }, resolved()).effect).toBeUndefined();
  });

  it('sends the user’s own text, not a paraphrase of it', () => {
    const result = plan({ intent: 'reply', body: 'I will send it Friday' }, resolved());
    expect(result.effect).toEqual({ kind: 'reply', body: 'I will send it Friday' });
  });

  it('honours mark unread rather than always marking read', () => {
    expect(plan({ intent: 'mark_read', read: false }, resolved()).effect).toEqual({
      kind: 'mutate',
      operation: { kind: 'markRead', read: false },
    });
  });
});
