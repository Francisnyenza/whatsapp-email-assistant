import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppError } from '@wea/shared';
import { AssistantService } from '../src/services/assistant.service.js';

/**
 * "Summarise this" and "translate it".
 *
 * The interesting property of summarise is that it usually costs nothing: every
 * inbound email is already analysed, and that analysis holds the summary the
 * notification card showed. Asking a model again would be paying twice for the
 * same sentence — so the first thing checked here is that it does not.
 *
 * The second is that when there is genuinely nothing stored, the on-demand
 * analysis is *saved*. The usual reason an email has no analysis is that the
 * provider was down or the budget was spent when it arrived, and both of those
 * pass — so the second person to ask, or the same person tomorrow, should not
 * pay again.
 */

const ANALYSIS = {
  summary: 'Sarah needs the Q3 report before Friday.',
  bulletSummary: ['Q3 report', 'Due Friday'],
  category: 'work' as const,
  priority: 'high' as const,
  urgencyScore: 0.7,
  spamScore: 0.01,
  language: 'en',
  requiresReply: true,
  sentiment: 'neutral' as const,
  entities: [],
  actionItems: [],
  suggestedReplies: ['On it'],
  containsInstructionLikeText: false,
};

const USAGE = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  model: 'gpt-4o-mini',
  provider: 'openai',
  latencyMs: 300,
  costMicros: 45,
};

const MESSAGE = {
  id: 'email-1',
  subject: 'Q3 report',
  fromName: 'Sarah Chen',
  fromAddress: 'sarah@acme.com',
  snippet: 'Could you send the Q3 report?',
  bodyTextCipher: null,
  bodyDek: null,
  bodyKeyVersion: null,
  locale: 'en',
};

describe('the assistant', () => {
  let service: AssistantService;
  let find: ReturnType<typeof vi.fn>;
  let save: ReturnType<typeof vi.fn>;
  let recordUsage: ReturnType<typeof vi.fn>;
  let complete: ReturnType<typeof vi.fn>;
  let speak: ReturnType<typeof vi.fn>;
  let findForAnalysis: ReturnType<typeof vi.fn>;
  let decryptMessageBody: ReturnType<typeof vi.fn>;
  let providerFor: () => unknown;
  let overBudget: boolean;
  let logger: any;

  beforeEach(() => {
    find = vi.fn().mockResolvedValue(null);
    save = vi.fn().mockResolvedValue(undefined);
    recordUsage = vi.fn().mockResolvedValue(undefined);
    complete = vi.fn().mockResolvedValue({ text: JSON.stringify(ANALYSIS), usage: USAGE });
    findForAnalysis = vi.fn().mockResolvedValue(MESSAGE);
    decryptMessageBody = vi.fn().mockResolvedValue('Could you send the Q3 report before Friday?');
    overBudget = false;
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    speak = vi.fn().mockResolvedValue({
      audio: Buffer.from('OggS-pretend-audio'),
      mimeType: 'audio/ogg',
      usage: { ...USAGE, model: 'gpt-4o-mini-tts' },
    });

    const provider = { name: 'stub', complete, speak };
    providerFor = () => provider;

    service = new AssistantService(
      { provider: () => providerFor(), isOverBudget: async () => overBudget } as never,
      { decryptMessageBody } as never,
      { find, save, recordUsage } as never,
      { findForAnalysis } as never,
      logger,
    );
  });

  describe('summarising', () => {
    it('uses the stored analysis rather than asking again', async () => {
      find.mockResolvedValue({
        summary: 'Sarah needs the Q3 report.',
        bulletSummary: [],
        containsInstructionLikeText: false,
      });

      const text = await service.summarize('user-1', 'email-1');

      expect(text).toContain('Sarah needs the Q3 report.');
      expect(complete).not.toHaveBeenCalled();
    });

    it('renders the bullets, because that is what a glance needs', async () => {
      find.mockResolvedValue({
        summary: 'Sarah needs the Q3 report.',
        bulletSummary: ['Q3 report', 'Due Friday'],
        containsInstructionLikeText: false,
      });

      const text = await service.summarize('user-1', 'email-1');

      expect(text).toContain('• Q3 report');
      expect(text).toContain('• Due Friday');
    });

    it('repeats the injection warning, since they may never have seen the card', async () => {
      find.mockResolvedValue({
        summary: 'Something.',
        bulletSummary: [],
        containsInstructionLikeText: true,
      });

      expect(await service.summarize('user-1', 'email-1')).toContain('⚠️');
    });

    it('analyses on demand when nothing is stored', async () => {
      const text = await service.summarize('user-1', 'email-1');

      expect(complete).toHaveBeenCalled();
      expect(text).toContain('Sarah needs the Q3 report before Friday.');
    });

    it('stores what it produced, so the next ask is free', async () => {
      // The usual reason an email has no analysis is a provider outage or a
      // spent budget when it arrived — both of which pass.
      await service.summarize('user-1', 'email-1');

      expect(save).toHaveBeenCalledWith(
        'user-1',
        'email-1',
        expect.objectContaining({ priority: 'high' }),
        expect.anything(),
        false,
      );
      expect(recordUsage).toHaveBeenCalledWith('user-1', 'analysis', expect.anything(), {
        cached: false,
      });
    });

    it('says so plainly when there is no provider to ask', async () => {
      providerFor = () => null;

      await expect(service.summarize('user-1', 'email-1')).rejects.toMatchObject({
        code: 'AI_UNAVAILABLE',
      });
    });

    it('says so when the budget is spent', async () => {
      overBudget = true;

      await expect(service.summarize('user-1', 'email-1')).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    });

    it('does not check the budget when it is not going to spend anything', async () => {
      // An exhausted allowance must not take away a summary already paid for.
      overBudget = true;
      find.mockResolvedValue({
        summary: 'Stored.',
        bulletSummary: [],
        containsInstructionLikeText: false,
      });

      expect(await service.summarize('user-1', 'email-1')).toContain('Stored.');
    });

    it('reports a message that has gone rather than answering about nothing', async () => {
      findForAnalysis.mockResolvedValue(null);

      await expect(service.summarize('user-1', 'email-1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('translating', () => {
    beforeEach(() => {
      complete.mockResolvedValue({ text: 'Sarah anahitaji ripoti ya Q3.', usage: USAGE });
    });

    it('returns the translation', async () => {
      expect(await service.translate('user-1', 'email-1', 'Swahili')).toBe(
        'Sarah anahitaji ripoti ya Q3.',
      );
    });

    it('meters it under its own task, not as analysis', async () => {
      // Composition runs on the expensive tier; folding it into the analysis
      // line would make the per-user cost report say the wrong thing.
      await service.translate('user-1', 'email-1', 'Swahili');
      expect(recordUsage).toHaveBeenCalledWith('user-1', 'translation', expect.anything());
    });

    it('says when it only translated part of a long email', async () => {
      findForAnalysis.mockResolvedValue({
        ...MESSAGE,
        snippet: 'x'.repeat(5_000),
      });

      expect(await service.translate('user-1', 'email-1', 'Swahili')).toContain('longer than fits');
    });

    it('needs a provider, and says so when there is none', async () => {
      providerFor = () => null;

      await expect(service.translate('user-1', 'email-1', 'Swahili')).rejects.toMatchObject({
        code: 'AI_UNAVAILABLE',
      });
    });

    it('refuses when the budget is spent', async () => {
      overBudget = true;

      await expect(service.translate('user-1', 'email-1', 'Swahili')).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    });
  });

  describe('drafting a reply', () => {
    beforeEach(() => {
      complete.mockResolvedValue({ text: 'I will have it by Thursday.', usage: USAGE });
    });

    it('returns words and nothing else', async () => {
      // No recipient, no subject, no headers. Those are computed server-side
      // from the original when the user confirms, so nothing the model or the
      // email says can redirect a reply.
      const draft = await service.draftReply('user-1', 'email-1', 'say Thursday');

      expect(draft).toBe('I will have it by Thursday.');
    });

    it('passes the user’s instruction through, since it is their own channel', async () => {
      await service.draftReply('user-1', 'email-1', 'politely decline');

      expect((complete.mock.calls[0]![0] as { user: string }).user).toContain('politely decline');
    });

    it('drafts without one, because "draft" alone is a reasonable thing to type', async () => {
      await expect(service.draftReply('user-1', 'email-1')).resolves.toBeTruthy();
    });

    it('meters it as composition, which is the expensive tier', async () => {
      await service.draftReply('user-1', 'email-1', 'say yes');
      expect(recordUsage).toHaveBeenCalledWith('user-1', 'composition', expect.anything());
    });

    it('refuses without a provider rather than sending an empty reply', async () => {
      providerFor = () => null;

      await expect(service.draftReply('user-1', 'email-1')).rejects.toMatchObject({
        code: 'AI_UNAVAILABLE',
      });
    });

    it('refuses when the budget is spent', async () => {
      overBudget = true;

      await expect(service.draftReply('user-1', 'email-1')).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      });
    });

    it('refuses when the email is gone', async () => {
      findForAnalysis.mockResolvedValue(null);

      await expect(service.draftReply('user-1', 'email-1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('the body', () => {
    it('is decrypted when we hold it', async () => {
      findForAnalysis.mockResolvedValue({
        ...MESSAGE,
        bodyTextCipher: new Uint8Array([1]),
        bodyDek: new Uint8Array([2]),
        bodyKeyVersion: 1,
      });

      await service.summarize('user-1', 'email-1');

      expect(decryptMessageBody).toHaveBeenCalled();
      expect((complete.mock.calls[0]![0] as { user: string }).user).toContain('before Friday');
    });

    it('falls back to the snippet once the body has been purged', async () => {
      // Thin, and much better than refusing to summarise mail we still hold.
      await service.summarize('user-1', 'email-1');

      expect(decryptMessageBody).not.toHaveBeenCalled();
      expect((complete.mock.calls[0]![0] as { user: string }).user).toContain(
        'Could you send the Q3 report?',
      );
    });

    it('falls back rather than failing when decryption breaks', async () => {
      findForAnalysis.mockResolvedValue({
        ...MESSAGE,
        bodyTextCipher: new Uint8Array([1]),
        bodyDek: new Uint8Array([2]),
        bodyKeyVersion: 1,
      });
      decryptMessageBody.mockRejectedValue(new AppError('ENCRYPTION_FAILURE', 'key gone'));

      await expect(service.summarize('user-1', 'email-1')).resolves.toContain('Q3');
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('reading aloud', () => {
    it('returns bytes and the type they are, without sending anything', async () => {
      // Nothing in this class can reach WhatsApp, and nothing here gains it.
      const spoken = await service.readAloud('user-1', 'email-1');

      expect(spoken.audio.length).toBeGreaterThan(0);
      expect(spoken.mimeType).toBe('audio/ogg');
    });

    it('speaks the sender and subject before the body', async () => {
      await service.readAloud('user-1', 'email-1');

      // The order is the point. A listener cannot skim, so the first second has
      // to carry the most useful fact — and it is also the only boundary
      // between our voice and the sender's.
      const script = speak.mock.calls[0]![0].text as string;
      expect(script).toMatch(/^Email from Sarah Chen\. Subject: Q3 report\. The message reads:/);
      expect(script.indexOf('Sarah Chen')).toBeLessThan(script.indexOf('Could you send'));
    });

    it('carries the type from the provider rather than assuming one', async () => {
      // WhatsApp rejects an upload whose declared type does not match its
      // bytes, and it only renders Ogg as a voice note when the codec is Opus.
      speak.mockResolvedValue({
        audio: Buffer.from('ID3-pretend-mp3'),
        mimeType: 'audio/mpeg',
        usage: USAGE,
      });

      expect((await service.readAloud('user-1', 'email-1')).mimeType).toBe('audio/mpeg');
    });

    it('charges the daily budget, so repeated asking is not free', async () => {
      await service.readAloud('user-1', 'email-1');

      expect(recordUsage).toHaveBeenCalledWith('user-1', 'speech', expect.anything());
    });

    it('refuses before spending anything when the budget is gone', async () => {
      overBudget = true;

      await expect(service.readAloud('user-1', 'email-1')).rejects.toThrow();
      expect(speak).not.toHaveBeenCalled();
    });

    it('says the message is gone rather than reading an empty one', async () => {
      findForAnalysis.mockResolvedValue(null);

      await expect(service.readAloud('user-1', 'email-1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('distinguishes no provider from a provider that cannot speak', async () => {
      // The whole reason the capability is optional. A deployment on Anthropic
      // has a working provider that has no speech API — telling that user "no
      // AI is set up" would send them looking for a key they already have.
      providerFor = () => null;
      const none = await service.readAloud('user-1', 'email-1').catch((e: AppError) => e);
      expect((none as AppError).publicMessage).toContain('no AI provider');

      providerFor = () => ({ name: 'anthropic', complete });
      const mute = await service.readAloud('user-1', 'email-1').catch((e: AppError) => e);
      expect((mute as AppError).publicMessage).toContain('voice provider');
      expect((mute as AppError).publicMessage).not.toContain('no AI provider');
    });

    it('does not retry a provider that structurally cannot speak', async () => {
      // Retrying would burn a job attempt to reach the same missing method.
      providerFor = () => ({ name: 'anthropic', complete });

      await expect(service.readAloud('user-1', 'email-1')).rejects.toMatchObject({
        retryable: false,
      });
    });

    it('reads the decrypted body, not the snippet', async () => {
      findForAnalysis.mockResolvedValue({
        ...MESSAGE,
        bodyTextCipher: new Uint8Array([1]),
        bodyDek: new Uint8Array([2]),
        bodyKeyVersion: 1,
      });

      await service.readAloud('user-1', 'email-1');

      expect(decryptMessageBody).toHaveBeenCalled();
      expect(speak.mock.calls[0]![0].text).toContain('Q3 report before Friday');
    });

    it('reports truncation so the caller knows, even though the audio says it too', async () => {
      findForAnalysis.mockResolvedValue({
        ...MESSAGE,
        bodyTextCipher: new Uint8Array([1]),
        bodyDek: new Uint8Array([2]),
        bodyKeyVersion: 1,
      });
      decryptMessageBody.mockResolvedValue('This sentence repeats. '.repeat(400));

      const spoken = await service.readAloud('user-1', 'email-1');

      expect(spoken.truncated).toBe(true);
      expect(speak.mock.calls[0]![0].text).toContain('That is where I stopped');
    });
  });
});
