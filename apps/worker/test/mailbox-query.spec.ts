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
  /** The mailbox's own filing names, for the "what labels do I have" read. */
  let labelNames: string[] = [];
  let search: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let deadlines: ReturnType<typeof vi.fn>;
  let embed: ReturnType<typeof vi.fn>;
  let recordUsage: ReturnType<typeof vi.fn>;
  let answerQuestionFrom: ReturnType<typeof vi.fn>;
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
    answerQuestionFrom = vi
      .fn()
      .mockResolvedValue({ text: 'Tom sent it on Tuesday.', usedSources: [0] });
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
      { answerQuestionFrom } as never,
      { list: async () => labelNames } as never,
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

    it('claims free-form questions, which are a read over the whole mailbox', () => {
      expect(service.handles({ intent: 'question', question: 'who?' })).toBe(true);
    });

    it('does not claim an action on one email', () => {
      // Those belong to the planner. Claiming one here would answer a delete
      // with a search result.
      expect(service.handles({ intent: 'archive' })).toBe(false);
      expect(service.handles({ intent: 'reply', body: 'sure' })).toBe(false);
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
      expect(await service.answer('user-1', { intent: 'archive' })).toBeNull();
    });
  });

  describe('answering a question', () => {
    it('retrieves fewer emails than a search shows', async () => {
      // Every source is third-party prose competing with the system prompt, so
      // each one added makes an injection marginally more likely to land — and a
      // question the top few cannot answer is rarely answered by the next six.
      await service.answer('user-1', { intent: 'question', question: 'did tom reply?' });

      expect(search.mock.calls[0]![2]).toMatchObject({ limit: 4 });
      expect(search.mock.calls[0]![2].limit).toBeLessThan(10);
    });

    it('passes the retrieved emails to the assistant, and the question with them', async () => {
      search.mockResolvedValue([hit('m1', 'Invoice 4471'), hit('m2', 'Re: Invoice 4471')]);

      await service.answer('user-1', { intent: 'question', question: '  did tom reply?  ' });

      const [userId, question, sources] = answerQuestionFrom.mock.calls[0]!;
      expect(userId).toBe('user-1');
      expect(question).toBe('did tom reply?');
      expect(sources).toHaveLength(2);
    });

    it('answers with the emails it cited, as tappable rows', async () => {
      // The citation and the way to check it are the same thing. An answer about
      // someone's mail is a claim, and a claim they cannot check is worse than
      // no answer at all.
      search.mockResolvedValue([hit('m1', 'Invoice 4471'), hit('m2', 'Re: Invoice 4471')]);
      answerQuestionFrom.mockResolvedValue({ text: 'Tom replied Tuesday.', usedSources: [1] });

      const payload = await service.answer('user-1', {
        intent: 'question',
        question: 'did tom reply?',
      });

      expect(bodyOf(payload)).toContain('Tom replied Tuesday.');
      expect(rowsOf(payload)).toHaveLength(1);
    });

    it('cannot show a row for an email it never retrieved', async () => {
      // The model answers in ordinals and never sees an id, so an out-of-range
      // citation resolves to nothing. This asserts the mapping honours that
      // rather than indexing into undefined and rendering an empty row.
      search.mockResolvedValue([hit('m1', 'Invoice 4471')]);
      answerQuestionFrom.mockResolvedValue({ text: 'Someone did.', usedSources: [0, 5] });

      const payload = await service.answer('user-1', { intent: 'question', question: 'who?' });

      const rows = rowsOf(payload);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('undefined');
    });

    it('falls back to plain text when the answer cites nothing', async () => {
      // A list with an empty section is rejected by the API, and "I can't tell
      // from these" is a complete answer that genuinely has no sources.
      answerQuestionFrom.mockResolvedValue({
        text: 'I can\u2019t tell from these.',
        usedSources: [],
      });

      const payload = await service.answer('user-1', { intent: 'question', question: 'who?' });

      expect(payload).toMatchObject({ kind: 'text' });
      expect(bodyOf(payload)).toContain('tell from these');
    });

    it('does not ask a model when nothing was retrieved', async () => {
      // Answering from nothing is answering from the model's imagination.
      search.mockResolvedValue([]);

      const payload = await service.answer('user-1', {
        intent: 'question',
        question: 'did the payment clear?',
      });

      expect(answerQuestionFrom).not.toHaveBeenCalled();
      expect(bodyOf(payload)).toContain('find any email');
    });

    it('says what does work when no model is configured, and searches nothing', async () => {
      providerFor = () => null;

      const payload = await service.answer('user-1', { intent: 'question', question: 'who?' });

      expect(bodyOf(payload)).toContain('search');
      expect(search).not.toHaveBeenCalled();
      expect(answerQuestionFrom).not.toHaveBeenCalled();
    });

    it('still retrieves when the query cannot be embedded', async () => {
      // Keyword and trigram carry the retrieval. A question is worth answering
      // from a slightly worse candidate set rather than not at all.
      embed.mockRejectedValue(new Error('provider down'));

      await service.answer('user-1', { intent: 'question', question: 'did tom reply?' });

      expect(search).toHaveBeenCalled();
      expect(search.mock.calls[0]![2]).not.toHaveProperty('vector');
      expect(answerQuestionFrom).toHaveBeenCalled();
    });
  });
});
