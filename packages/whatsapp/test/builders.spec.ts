import { describe, it, expect } from 'vitest';
import {
  buildEmailNotification,
  buildDigest,
  buildSendConfirmation,
  buildDeleteConfirmation,
  buildDraftConfirmation,
  buildDisambiguation,
  buildSearchResults,
  enforceLimits,
  clamp,
  serializePayload,
  type EmailNotificationInput,
} from '../src/index.js';
import { WHATSAPP_LIMITS, decodeActionPayload } from '@wea/shared';

const input = (overrides: Partial<EmailNotificationInput> = {}): EmailNotificationInput => ({
  emailMessageId: 'msg-abc123',
  fromName: 'Sarah Chen',
  fromAddress: 'sarah.chen@acme.com',
  subject: 'Q3 sales report — need it before Friday',
  receivedAt: new Date('2026-08-04T14:30:00Z'),
  priority: 'high',
  category: 'work',
  summary: 'Sarah needs the Q3 sales report before Friday for a Monday board meeting.',
  attachmentCount: 0,
  attachmentNames: [],
  suggestedReplies: ['On it — sending today.'],
  timezone: 'Africa/Nairobi',
  locale: 'en-GB',
  ...overrides,
});

describe('clamp', () => {
  it('leaves short text alone', () => {
    expect(clamp('hello', 20)).toBe('hello');
  });

  it('truncates at a word boundary', () => {
    expect(clamp('the quick brown fox jumps', 20)).toBe('the quick brown…');
  });

  it('never exceeds the limit', () => {
    for (const max of [1, 2, 5, 20, 60]) {
      expect(Array.from(clamp('a'.repeat(200), max)).length, `max ${max}`).toBeLessThanOrEqual(max);
    }
  });

  it('does not split an emoji into a replacement character', () => {
    // Meta counts characters; splitting a surrogate pair renders as a broken
    // glyph on the user's phone.
    const result = clamp('🎉🎉🎉🎉🎉', 3);
    expect(result).not.toContain('�');
    expect(Array.from(result).length).toBeLessThanOrEqual(3);
  });

  it('handles text with no spaces', () => {
    const result = clamp('a'.repeat(50), 10);
    expect(Array.from(result).length).toBe(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('email notification card', () => {
  it('leads with sender, subject and time', () => {
    const card = buildEmailNotification(input());
    expect(card.body).toContain('Sarah Chen');
    expect(card.body).toContain('Q3 sales report');
    // 14:30 UTC is 17:30 in Nairobi — the user's own timezone, not the server's.
    expect(card.body).toContain('17:30');
  });

  it('includes the AI summary', () => {
    expect(buildEmailNotification(input()).body).toContain('Monday board meeting');
  });

  it('marks urgent mail visibly', () => {
    expect(buildEmailNotification(input({ priority: 'urgent' })).header).toContain('URGENT');
    expect(buildEmailNotification(input({ priority: 'normal' })).header).not.toContain('URGENT');
  });

  it('lists attachments and counts the overflow', () => {
    const card = buildEmailNotification(
      input({
        attachmentCount: 5,
        attachmentNames: ['report.pdf', 'data.xlsx', 'notes.docx', 'x.png', 'y.zip'],
      }),
    );
    expect(card.body).toContain('5 attachments');
    expect(card.body).toContain('report.pdf');
    expect(card.body).toContain('+2 more');
  });

  it('warns when the email tried to instruct an assistant', () => {
    // Surfaced to the user, never acted on (ADR 0004).
    const card = buildEmailNotification(input({ flaggedForInstructionText: true }));
    expect(card.body).toContain('⚠️');
    expect(card.body.toLowerCase()).toContain('instructions');
  });

  it('handles a missing subject and sender name', () => {
    const card = buildEmailNotification(
      input({ subject: '', fromName: undefined, summary: undefined }),
    );
    expect(card.body).toContain('(no subject)');
    expect(card.body).toContain('sarah.chen@acme.com');
  });

  describe('buttons', () => {
    it('mints payloads carrying our own record id', () => {
      // A tap is an authorization, which only works because the id is
      // server-minted and never derived from email content (ADR 0004).
      const card = buildEmailNotification(input());
      for (const button of card.buttons) {
        const decoded = decodeActionPayload(button.id);
        expect(decoded).not.toBeNull();
        expect(decoded?.targetId).toBe('msg-abc123');
      }
    });

    it('offers the suggested reply first', () => {
      const card = buildEmailNotification(input());
      expect(card.buttons[0]?.title).toContain('On it');
      expect(decodeActionPayload(card.buttons[0]!.id)?.action).toBe('reply_yes');
    });

    it('still offers reply and archive without a suggestion', () => {
      const card = buildEmailNotification(input({ suggestedReplies: [] }));
      const actions = card.buttons.map((b) => decodeActionPayload(b.id)?.action);
      expect(actions).toContain('reply');
      expect(actions).toContain('archive');
    });

    it('never offers delete as a one-tap action', () => {
      // Destructive verbs go through a confirmation step, so they are not
      // reachable by a single mis-tap on a notification.
      const card = buildEmailNotification(input());
      const actions = card.buttons.map((b) => decodeActionPayload(b.id)?.action);
      expect(actions).not.toContain('delete');
      expect(actions).not.toContain('confirm_delete');
    });

    it('respects Meta’s three-button ceiling', () => {
      const card = buildEmailNotification(
        input({ suggestedReplies: ['Yes', 'No', 'Maybe', 'Later'] }),
      );
      expect(card.buttons.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonCount);
    });
  });

  it('stays inside every Meta limit, even with hostile input', () => {
    const card = buildEmailNotification(
      input({
        subject: 'x'.repeat(5000),
        summary: 'y'.repeat(5000),
        fromName: 'z'.repeat(500),
        suggestedReplies: ['a'.repeat(200)],
        attachmentCount: 40,
        attachmentNames: Array.from({ length: 40 }, (_, i) => `file-${i}-${'n'.repeat(100)}.pdf`),
      }),
    );

    expect(Array.from(card.body).length).toBeLessThanOrEqual(WHATSAPP_LIMITS.interactiveBody);
    expect(Array.from(card.header!).length).toBeLessThanOrEqual(WHATSAPP_LIMITS.headerText);
    expect(Array.from(card.footer!).length).toBeLessThanOrEqual(WHATSAPP_LIMITS.footerText);
    for (const button of card.buttons) {
      expect(Array.from(button.title).length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonTitle);
    }
  });
});

describe('digest', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({
    emailMessageId: `msg-${i}`,
    fromName: `Sender ${i}`,
    fromAddress: `s${i}@example.com`,
    subject: `Subject number ${i}`,
    priority: (i < 3 ? 'high' : 'normal') as const,
  }));

  it('summarizes the count and how many need attention', () => {
    const digest = buildDigest(items);
    expect(digest.body).toContain('15');
    expect(digest.body).toContain('3');
  });

  it('caps rows at Meta’s limit and says how many were left out', () => {
    const digest = buildDigest(items);
    expect(digest.sections[0]?.rows.length).toBe(WHATSAPP_LIMITS.listRowCount);
    expect(digest.body).toContain('5 more');
  });

  it('makes every row open exactly one email', () => {
    for (const row of buildDigest(items).sections[0]!.rows) {
      expect(decodeActionPayload(row.id)?.action).toBe('open_thread');
    }
  });

  it('handles a single email without mangling the grammar', () => {
    const body = buildDigest(items.slice(0, 1)).body;
    expect(body).toContain('new email.');
    expect(body).not.toContain('emails');
    expect(body).toContain('needs attention');
  });
});

describe('confirmations', () => {
  it('offers send, edit and cancel before a reply goes out', () => {
    const card = buildSendConfirmation('draft-1', 'sarah@acme.com', 'Sending it this afternoon.');
    const actions = card.buttons.map((b) => decodeActionPayload(b.id)?.action);
    expect(actions).toEqual(['confirm_send', 'reply', 'cancel']);
    expect(card.body).toContain('sarah@acme.com');
  });

  it('says the reply comes from the user’s own address', () => {
    // The product promise, restated where the user can see it.
    const card = buildSendConfirmation('draft-1', 'sarah@acme.com', 'text');
    expect(card.footer).toContain('your own email address');
  });

  it('binds a delete confirmation to one specific message', () => {
    const card = buildDeleteConfirmation('msg-9', 'Invoice #INV-2291');
    const confirm = card.buttons.find(
      (b) => decodeActionPayload(b.id)?.action === 'confirm_delete',
    );
    expect(decodeActionPayload(confirm!.id)?.targetId).toBe('msg-9');
    expect(card.body).toContain('Invoice #INV-2291');
  });
});

describe('draft confirmation', () => {
  const DRAFT = 'Thanks — I will have the report with you by Thursday.';

  it('shows the whole draft, not a preview', () => {
    // A confirmation only means something if the user read what they approved,
    // and "…" mid-sentence is how someone sends a paragraph they never saw.
    const payload = buildDraftConfirmation('m1', DRAFT);
    expect(payload.body).toBe(DRAFT);
  });

  it('carries our own id and never the words', () => {
    // WhatsApp echoes an interactive id straight back, so text placed there is
    // text the client could change — the user would approve one email and send
    // another.
    const payload = buildDraftConfirmation('m1', DRAFT);

    for (const button of payload.buttons) {
      expect(button.id).not.toContain('Thursday');
      expect(decodeActionPayload(button.id)?.targetId).toBe('m1');
    }
  });

  it('offers send, write-my-own and cancel', () => {
    const actions = buildDraftConfirmation('m1', DRAFT).buttons.map(
      (b) => decodeActionPayload(b.id)?.action,
    );
    expect(actions).toEqual(['confirm_send', 'reply', 'cancel']);
  });

  it('says where it will be sent from, because that is the whole promise', () => {
    expect(buildDraftConfirmation('m1', DRAFT).footer).toContain('own address');
  });

  it('clamps a draft that would exceed the body limit', () => {
    const payload = buildDraftConfirmation('m1', 'x'.repeat(5_000));
    expect(payload.body.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.interactiveBody);
  });
});

describe('disambiguation', () => {
  it('asks rather than guessing which email was meant', () => {
    // Rank 5 on the ladder (ADR 0003). A misrouted reply is unrecoverable.
    const list = buildDisambiguation([
      { emailMessageId: 'm1', fromName: 'Sarah', fromAddress: 's@a.com', subject: 'Report' },
      { emailMessageId: 'm2', fromName: 'Sara', fromAddress: 'sara@b.com', subject: 'Invoice' },
    ]);

    expect(list.sections[0]?.rows).toHaveLength(2);
    expect(list.sections[0]?.rows.map((r) => decodeActionPayload(r.id)?.targetId)).toEqual([
      'm1',
      'm2',
    ]);
  });
});

describe('search results', () => {
  const hit = (id: string, subject: string) => ({
    emailMessageId: id,
    fromName: 'Sarah Chen',
    fromAddress: 'sarah@acme.com',
    subject,
    isUnread: false,
  });

  it('renders matches as a tappable list carrying our own ids', () => {
    // A row id is a server-minted target. That is what makes the tap that
    // follows an authorization rather than a guess at what the user meant.
    const payload = buildSearchResults('invoice', [
      hit('m1', 'Invoice 4471'),
      hit('m2', 'Receipt'),
    ]);

    expect(payload.kind).toBe('list');
    const rows = (payload as { sections: Array<{ rows: Array<{ id: string }> }> }).sections[0]!
      .rows;
    expect(rows.map((r) => decodeActionPayload(r.id)?.targetId)).toEqual(['m1', 'm2']);
    expect(rows.map((r) => decodeActionPayload(r.id)?.action)).toEqual([
      'open_thread',
      'open_thread',
    ]);
  });

  it('says nothing was found, and suggests what to try instead', () => {
    // An assistant that goes quiet reads as broken.
    const payload = buildSearchResults('zzz', []);

    expect(payload.kind).toBe('text');
    expect((payload as { body: string }).body).toContain('zzz');
    expect((payload as { body: string }).body.toLowerCase()).toContain('subject');
  });

  it('marks unread results so the list is scannable', () => {
    const payload = buildSearchResults('invoice', [{ ...hit('m1', 'Invoice'), isUnread: true }]);
    const rows = (payload as { sections: Array<{ rows: Array<{ title: string }> }> }).sections[0]!
      .rows;

    expect(rows[0]!.title.startsWith('•')).toBe(true);
  });

  it('never exceeds the row limit, and says so when it truncates', () => {
    const many = Array.from({ length: 30 }, (_, i) => hit(`m${i}`, `Invoice ${i}`));
    const payload = buildSearchResults('invoice', many) as {
      body: string;
      sections: Array<{ rows: unknown[] }>;
    };

    expect(payload.sections[0]!.rows).toHaveLength(WHATSAPP_LIMITS.listRowCount);
    expect(payload.body).toContain('closest');
  });

  it('clamps a query long enough to blow the header limit', () => {
    const payload = buildSearchResults('x'.repeat(500), [hit('m1', 'Invoice')]) as {
      header: string;
    };

    expect(payload.header.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.headerText);
  });
});

describe('enforceLimits', () => {
  it('clamps a payload built elsewhere, such as AI-drafted text', () => {
    const clamped = enforceLimits({
      kind: 'buttons',
      header: 'h'.repeat(200),
      body: 'b'.repeat(5000),
      footer: 'f'.repeat(200),
      buttons: Array.from({ length: 8 }, (_, i) => ({
        id: `act:reply:m${i}`,
        title: 't'.repeat(50),
      })),
    });

    if (clamped.kind !== 'buttons') throw new Error('kind changed');
    expect(Array.from(clamped.body).length).toBeLessThanOrEqual(WHATSAPP_LIMITS.interactiveBody);
    expect(clamped.buttons).toHaveLength(WHATSAPP_LIMITS.buttonCount);
  });

  it('clamps list rows and descriptions', () => {
    const clamped = enforceLimits({
      kind: 'list',
      body: 'body',
      buttonText: 'x'.repeat(50),
      sections: [
        {
          title: 'Section',
          rows: Array.from({ length: 20 }, (_, i) => ({
            id: `act:open_thread:m${i}`,
            title: 'title'.repeat(20),
            description: 'description'.repeat(30),
          })),
        },
      ],
    });

    if (clamped.kind !== 'list') throw new Error('kind changed');
    const rows = clamped.sections[0]!.rows;
    expect(rows).toHaveLength(WHATSAPP_LIMITS.listRowCount);
    expect(Array.from(rows[0]!.title).length).toBeLessThanOrEqual(WHATSAPP_LIMITS.listRowTitle);
  });

  it('leaves templates untouched, since Meta validates those itself', () => {
    const template = { kind: 'template' as const, name: 'new_email_v3', languageCode: 'en' };
    expect(enforceLimits(template)).toEqual(template);
  });
});

describe('wire serialization', () => {
  it('serializes buttons into Meta’s interactive shape', () => {
    const wire = serializePayload({
      kind: 'buttons',
      header: 'New email',
      body: 'From Sarah',
      footer: 'Reply here',
      buttons: [{ id: 'act:reply:m1', title: 'Reply' }],
    }) as any;

    expect(wire.type).toBe('interactive');
    expect(wire.interactive.type).toBe('button');
    expect(wire.interactive.action.buttons[0]).toEqual({
      type: 'reply',
      reply: { id: 'act:reply:m1', title: 'Reply' },
    });
  });

  it('omits optional sections rather than sending nulls', () => {
    // Meta rejects a null header outright.
    const wire = serializePayload({ kind: 'buttons', body: 'b', buttons: [] }) as any;
    expect(wire.interactive).not.toHaveProperty('header');
    expect(wire.interactive).not.toHaveProperty('footer');
  });

  it('serializes text with link previews off by default', () => {
    const wire = serializePayload({ kind: 'text', body: 'hello' }) as any;
    expect(wire.text).toEqual({ body: 'hello', preview_url: false });
  });

  it('serializes media under its own type key', () => {
    const wire = serializePayload({
      kind: 'media',
      mediaType: 'document',
      mediaId: 'media-1',
      filename: 'invoice.pdf',
    }) as any;

    expect(wire.type).toBe('document');
    expect(wire.document).toEqual({ id: 'media-1', filename: 'invoice.pdf' });
  });

  it('serializes a template with its language code', () => {
    const wire = serializePayload({
      kind: 'template',
      name: 'new_email_v3',
      languageCode: 'sw',
    }) as any;

    expect(wire.template.name).toBe('new_email_v3');
    expect(wire.template.language).toEqual({ code: 'sw' });
  });
});
