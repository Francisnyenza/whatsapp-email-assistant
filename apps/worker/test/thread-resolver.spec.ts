import { describe, it, expect, vi } from 'vitest';
import {
  ThreadResolver,
  matchByName,
  type ResolutionCandidate,
  type ResolutionContext,
} from '../src/services/thread-resolver.js';
import type { InboundWhatsAppMessage } from '@wea/shared';

/**
 * The ladder from ADR 0003.
 *
 * A misrouted reply sends a user's words to the wrong person. It cannot be
 * undone and it is the single worst thing this system could do, so the
 * behaviour under uncertainty — ask, never guess — matters more than any
 * individual match.
 */

const resolver = new ThreadResolver();
const now = new Date('2026-08-04T12:00:00Z');

const candidate = (over: Partial<ResolutionCandidate> = {}): ResolutionCandidate => ({
  emailMessageId: 'email-1',
  fromAddress: 'sarah.chen@acme.com',
  fromName: 'Sarah Chen',
  subject: 'Q3 report',
  receivedAt: new Date('2026-08-04T11:00:00Z'),
  ...over,
});

const message = (over: Partial<InboundWhatsAppMessage> = {}): InboundWhatsAppMessage => ({
  id: 'wamid.IN',
  from: '254712345678',
  timestamp: now,
  type: 'text',
  text: 'yes',
  ...over,
});

const ctx = (over: Partial<ResolutionContext> = {}): ResolutionContext => ({
  deliveryLookup: vi.fn().mockResolvedValue(null),
  recent: [],
  now,
  ...over,
});

describe('rank 1 — native reply', () => {
  it('resolves through our delivery record', async () => {
    const result = await resolver.resolve(
      message({ context: { id: 'wamid.OUT' } }),
      ctx({ deliveryLookup: vi.fn().mockResolvedValue('email-42') }),
    );

    expect(result).toMatchObject({ outcome: 'resolved', emailMessageId: 'email-42', rank: 1 });
  });

  it('outranks an active conversation about a different email', async () => {
    // The user pointed at something specific. That beats whatever we were
    // last talking about.
    const result = await resolver.resolve(
      message({ context: { id: 'wamid.OUT' } }),
      ctx({
        deliveryLookup: vi.fn().mockResolvedValue('email-42'),
        activeEmailMessageId: 'email-99',
      }),
    );

    expect(result).toMatchObject({ emailMessageId: 'email-42', rank: 1 });
  });

  it('falls through rather than guessing when the reference is unmappable', async () => {
    // They replied to a message past retention. They clearly had one specific
    // email in mind, so silently picking a different one is the worst outcome.
    const result = await resolver.resolve(
      message({ context: { id: 'wamid.ANCIENT' } }),
      ctx({
        recent: [
          candidate({ emailMessageId: 'a' }),
          candidate({ emailMessageId: 'b', fromAddress: 'tom@acme.com' }),
        ],
      }),
    );

    expect(result.outcome).toBe('ambiguous');
  });
});

describe('rank 2 — a button we minted', () => {
  it('resolves from the action payload', async () => {
    const result = await resolver.resolve(
      message({
        type: 'interactive',
        interactive: { type: 'button_reply', id: 'act:reply:email-7', title: 'Reply' },
      }),
      ctx(),
    );

    expect(result).toMatchObject({ outcome: 'resolved', emailMessageId: 'email-7', rank: 2 });
  });

  it('ignores a payload that is not ours', async () => {
    // Decoding returns null for anything malformed, and we must not treat
    // attacker-shaped input as an identifier.
    const result = await resolver.resolve(
      message({
        type: 'interactive',
        interactive: { type: 'button_reply', id: '../../etc/passwd', title: 'x' },
      }),
      ctx({ recent: [candidate()] }),
    );

    expect(result.outcome).toBe('resolved');
    expect((result as any).rank).not.toBe(2);
  });
});

describe('rank 3 — active conversation', () => {
  it('continues the conversation in progress', async () => {
    const result = await resolver.resolve(
      message(),
      ctx({
        activeEmailMessageId: 'email-5',
        activeStateExpiresAt: new Date(now.getTime() + 600_000),
      }),
    );

    expect(result).toMatchObject({ outcome: 'resolved', emailMessageId: 'email-5', rank: 3 });
  });

  it('ignores an expired conversation', async () => {
    // "yes" half an hour later may well concern something else entirely.
    const result = await resolver.resolve(
      message(),
      ctx({
        activeEmailMessageId: 'email-5',
        activeStateExpiresAt: new Date(now.getTime() - 1000),
        recent: [
          candidate({ emailMessageId: 'a' }),
          candidate({ emailMessageId: 'b', fromAddress: 'tom@acme.com' }),
        ],
      }),
    );

    expect(result.outcome).toBe('ambiguous');
  });
});

describe('rank 4 — a named target', () => {
  const recent = [
    candidate({
      emailMessageId: 'e-sarah',
      fromAddress: 'sarah.chen@acme.com',
      fromName: 'Sarah Chen',
    }),
    candidate({ emailMessageId: 'e-tom', fromAddress: 'tom@acme.com', fromName: 'Tom Riley' }),
  ];

  it('matches a first name', async () => {
    const result = await resolver.resolve(message(), ctx({ recent, namedTarget: 'Sarah' }));
    expect(result).toMatchObject({ outcome: 'resolved', emailMessageId: 'e-sarah', rank: 4 });
  });

  it('matches a full address', async () => {
    const result = await resolver.resolve(message(), ctx({ recent, namedTarget: 'tom@acme.com' }));
    expect(result).toMatchObject({ emailMessageId: 'e-tom' });
  });

  it('asks when a name matches two people', async () => {
    // Two Sarahs is a question, not a coin flip.
    const twoSarahs = [
      candidate({
        emailMessageId: 'e-1',
        fromAddress: 'sarah.chen@acme.com',
        fromName: 'Sarah Chen',
      }),
      candidate({
        emailMessageId: 'e-2',
        fromAddress: 'sarah.okoth@other.com',
        fromName: 'Sarah Okoth',
      }),
    ];

    const result = await resolver.resolve(
      message(),
      ctx({ recent: twoSarahs, namedTarget: 'Sarah' }),
    );

    expect(result.outcome).toBe('ambiguous');
    expect((result as any).options).toHaveLength(2);
  });

  it('reports nothing found rather than offering unrelated emails', async () => {
    // They asked for a specific person; a list of everyone else is misleading.
    const result = await resolver.resolve(message(), ctx({ recent, namedTarget: 'Priya' }));
    expect(result.outcome).toBe('none');
  });
});

describe('rank 5 — ask', () => {
  it('asks when several emails could be meant', async () => {
    const result = await resolver.resolve(
      message(),
      ctx({
        recent: [
          candidate({ emailMessageId: 'a' }),
          candidate({ emailMessageId: 'b', fromAddress: 'tom@acme.com' }),
          candidate({ emailMessageId: 'c', fromAddress: 'ops@acme.com' }),
        ],
      }),
    );

    expect(result.outcome).toBe('ambiguous');
    expect((result as any).options).toHaveLength(3);
  });

  it('caps the options at a list WhatsApp can render', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      candidate({ emailMessageId: `e-${i}`, fromAddress: `p${i}@acme.com` }),
    );
    const result = await resolver.resolve(message(), ctx({ recent: many }));
    expect((result as any).options).toHaveLength(10);
  });

  it('accepts the only recent email without asking', async () => {
    // Not certainty, but the only thing they could plausibly mean.
    const result = await resolver.resolve(message(), ctx({ recent: [candidate()] }));
    expect(result.outcome).toBe('resolved');
  });

  it('reports none when there is nothing to reply to', async () => {
    expect((await resolver.resolve(message(), ctx())).outcome).toBe('none');
  });

  it('never resolves to an email under genuine ambiguity', async () => {
    // The invariant this whole module exists to hold.
    const result = await resolver.resolve(
      message(),
      ctx({
        recent: [
          candidate({ emailMessageId: 'a' }),
          candidate({ emailMessageId: 'b', fromAddress: 'tom@acme.com' }),
        ],
      }),
    );
    expect(result).not.toHaveProperty('emailMessageId');
  });
});

describe('name matching is conservative', () => {
  const people = [
    candidate({
      emailMessageId: 'e-sam',
      fromAddress: 'samantha@acme.com',
      fromName: 'Samantha Reid',
    }),
    candidate({
      emailMessageId: 'e-chen',
      fromAddress: 'sarah.chen@acme.com',
      fromName: 'Sarah Chen',
      aliases: ['boss'],
    }),
  ];

  it('does not match a bare substring', () => {
    // "sam" matching "Samantha" would quietly reply to the wrong person.
    expect(matchByName('sam', people)).toHaveLength(0);
  });

  it('matches a whole word in a display name', () => {
    expect(matchByName('chen', people).map((c) => c.emailMessageId)).toEqual(['e-chen']);
  });

  it('matches a stored alias', () => {
    expect(matchByName('boss', people).map((c) => c.emailMessageId)).toEqual(['e-chen']);
  });

  it('matches the local part of an address', () => {
    expect(matchByName('samantha', people).map((c) => c.emailMessageId)).toEqual(['e-sam']);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(matchByName('  SARAH  ', people)).toHaveLength(1);
  });

  it('collapses several emails from one person into one option', () => {
    // Three emails from Sarah is one Sarah — presenting her three times as
    // "ambiguous" would be absurd.
    const threeFromSarah = [
      candidate({ emailMessageId: 'a', fromAddress: 'sarah@acme.com', fromName: 'Sarah Chen' }),
      candidate({ emailMessageId: 'b', fromAddress: 'sarah@acme.com', fromName: 'Sarah Chen' }),
      candidate({ emailMessageId: 'c', fromAddress: 'sarah@acme.com', fromName: 'Sarah Chen' }),
    ];
    expect(matchByName('sarah', threeFromSarah)).toHaveLength(1);
  });

  it('returns nothing for empty input', () => {
    expect(matchByName('', people)).toHaveLength(0);
    expect(matchByName('   ', people)).toHaveLength(0);
  });
});
