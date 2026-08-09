import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError } from '@wea/shared';
import { MailboxQueryService } from '../src/services/mailbox-query.service.js';

/**
 * Search and the standing lists.
 *
 * The rule this file enforces is that **search degrades rather than fails**.
 * Every reason the semantic arm might not run — no provider, budget spent,
 * provider down — still has to produce results, because keyword and trigram
 * search do not need a model at all. A deployment with no API key has working
 * search; it just has slightly worse ranking, and it should not apologise for it
 * on every query.
 */

const VECTOR = Array.from({ length: 1536 }, (_, i) => i / 1536);

const USAGE = {
  promptTokens: 4,
  completionTokens: 0,
  totalTokens: 4,
  model: 'text-embedding-3-small',
  provider: 'openai',
  latencyMs: 40,
  costMicros: 1,
};

const hit = (id: string, subject: string) => ({
  emailMessageId: id,
  subject,
  fromName: 'Sarah Chen',
  fromAddress: 'sarah@acme.com',
  snippet: 'preview',
  receivedAt: new Date('2026-08-04T10:00:00Z'),
  isUnread: true,
  score: 0.03,
});

describe('mailbox queries', () => {
  let service: MailboxQueryService;
  let search: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let deadlines: ReturnType<typeof vi.fn>;
  let embed: ReturnType<typeof vi.fn>;
  let recordUsage: ReturnType<typeof vi.fn>;
  let providerFor: () => unknown;
  let secondaryFor: () => unknown;
  let overBudget: boolean;
  let logger: any;

  beforeEach(() => {
    search = vi.fn().mockResolvedValue([hit('m1', 'Invoice 4471')]);
    list = vi.fn().mockResolvedValue([hit('m1', 'Invoice 4471')]);
    deadlines = vi.fn().mockResolvedValue([]);
    embed = vi.fn().mockResolvedValue({ vector: VECTOR, usage: USAGE });
    recordUsage = vi.fn().mockResolvedValue(undefined);
    overBudget = false;
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const provider = { name: 'stub', complete: vi.fn(), embed };
    providerFor = () => provider;
    secondaryFor = () => null;

    service = new MailboxQueryService(
      { search, list, deadlines } as never,
      {
        provider: () => providerFor(),
        secondary: () => secondaryFor(),
        isOverBudget: async () => overBudget,
      } as never,
      { recordUsage } as never,
      logger,
    );
  });

  const rowsOf = (payload: unknown) =>
    (payload as { sections?: Array<{ rows: Array<{ id: string }> }> }).sections?.[0]?.rows ?? [];

  const bodyOf = (payload: unknown) => (payload as { body: string }).body;

  describe('what it handles', () => {
    it('claims search and the standing lists', () => {
      expect(service.handles({ intent: 'search', query: 'x' })).toBe(true);
      expect(service.handles({ intent: 'list_unread' })).toBe(true);
      expect(service.handles({ intent: 'list_today' })).toBe(true);
      expect(service.handles({ intent: 'list_urgent' })).toBe(true);
    });

    it('leaves everything that concerns one email to the planner', () => {
      expect(service.handles({ intent: 'archive' })).toBe(false);
      expect(service.handles({ intent: 'reply' })).toBe(false);
      expect(service.handles({ intent: 'delete' })).toBe(false);
      expect(service.handles({ intent: 'help' })).toBe(false);
    });

    it('claims deadlines, which are a read over extracted action items', () => {
      expect(service.handles({ intent: 'list_deadlines' })).toBe(true);
    });

    it('does not claim what it cannot actually answer', () => {
      // A free-form question needs the model to reason over the mailbox, which
      // is a different thing entirely from a query with a shape.
      expect(service.handles({ intent: 'question', question: 'who?' })).toBe(false);
    });
  });

  describe('search', () => {
    it('embeds the query and passes the vector down', async () => {
      await service.answer('user-1', { intent: 'search', query: 'invoices from Tom' });

      expect(embed).toHaveBeenCalled();
      expect(search.mock.calls[0]![2]).toMatchObject({ vector: VECTOR });
    });

    it('meters the embedding call', async () => {
      await service.answer('user-1', { intent: 'search', query: 'invoices' });
      expect(recordUsage).toHaveBeenCalledWith('user-1', 'embedding', expect.anything());
    });

    it('returns results as a tappable list', async () => {
      const payload = await service.answer('user-1', { intent: 'search', query: 'invoices' });
      expect(rowsOf(payload)).toHaveLength(1);
    });

    it('trims the query before searching', async () => {
      await service.answer('user-1', { intent: 'search', query: '  invoices  ' });
      expect(search.mock.calls[0]![1]).toBe('invoices');
    });

    it('asks what to look for rather than searching for nothing', async () => {
      const payload = await service.answer('user-1', { intent: 'search', query: ' a ' });

      expect(search).not.toHaveBeenCalled();
      expect(bodyOf(payload)).toContain('search for');
    });

    it('says plainly when nothing matched', async () => {
      search.mockResolvedValue([]);

      const payload = await service.answer('user-1', { intent: 'search', query: 'zzz' });

      expect(bodyOf(payload)).toContain('zzz');
    });
  });

  describe('search still works without a model', () => {
    const expectKeywordOnly = async () => {
      const payload = await service.answer('user-1', { intent: 'search', query: 'invoices' });

      expect(search).toHaveBeenCalled();
      expect(search.mock.calls[0]![2]).not.toHaveProperty('vector');
      // And it does not apologise: the user got results.
      expect(rowsOf(payload)).toHaveLength(1);
    };

    it('with no provider configured', async () => {
      providerFor = () => null;
      await expectKeywordOnly();
      expect(embed).not.toHaveBeenCalled();
    });

    it('with the daily budget spent', async () => {
      overBudget = true;
      await expectKeywordOnly();
      expect(embed).not.toHaveBeenCalled();
    });

    it('with the provider down', async () => {
      embed.mockRejectedValue(new AppError('AI_UNAVAILABLE', 'down', { retryable: true }));
      await expectKeywordOnly();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not bill for an embedding that failed', async () => {
      embed.mockRejectedValue(new AppError('AI_UNAVAILABLE', 'down', { retryable: true }));

      await service.answer('user-1', { intent: 'search', query: 'invoices' });

      expect(recordUsage).not.toHaveBeenCalled();
    });

    it('records which arms ran, because that belongs in a log and not in a message', async () => {
      providerFor = () => null;

      await service.answer('user-1', { intent: 'search', query: 'invoices' });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'search.performed', semantic: false }),
        expect.anything(),
      );
    });
  });

  describe('the standing lists', () => {
    it('maps each intent to its own query', async () => {
      await service.answer('user-1', { intent: 'list_unread' });
      await service.answer('user-1', { intent: 'list_today' });
      await service.answer('user-1', { intent: 'list_urgent' });

      expect(list.mock.calls.map((c) => c[1])).toEqual(['unread', 'today', 'urgent']);
    });

    it('never embeds — a list is not a search', async () => {
      await service.answer('user-1', { intent: 'list_unread' });
      expect(embed).not.toHaveBeenCalled();
    });

    it('renders as a tappable list', async () => {
      const payload = await service.answer('user-1', { intent: 'list_unread' });
      expect(rowsOf(payload)).toHaveLength(1);
    });

    it('says something specific when a list is empty', async () => {
      list.mockResolvedValue([]);

      expect(bodyOf(await service.answer('user-1', { intent: 'list_unread' }))).toContain(
        'caught up',
      );
      expect(bodyOf(await service.answer('user-1', { intent: 'list_today' }))).toContain('today');
      expect(bodyOf(await service.answer('user-1', { intent: 'list_urgent' }))).toContain('urgent');
    });

    it('returns null for an intent it does not own, rather than a wrong answer', async () => {
      expect(await service.answer('user-1', { intent: 'question', question: 'who?' })).toBeNull();
    });
  });
});
