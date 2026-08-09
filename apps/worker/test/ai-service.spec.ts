import { describe, it, expect, vi } from 'vitest';
import { canEmbed } from '@wea/ai';
import { AiService } from '../src/services/ai.service.js';

/**
 * Choosing a provider.
 *
 * This class had a bug of a particular kind, and these tests exist to keep it
 * from coming back: `AI_PRIMARY_PROVIDER` accepted `gemini` and `anthropic`
 * while only OpenAI was implemented, so selecting either passed validation,
 * passed boot, logged "not configured" once, and then delivered every email
 * without a summary. A setting that reads as on and behaves as off, with a
 * single info line as the only evidence.
 *
 * The rule that replaced it: a provider named in the environment either resolves
 * to an implementation or refuses to start.
 */

const base = {
  AI_PRIMARY_PROVIDER: 'openai' as const,
  AI_FALLBACK_PROVIDER: 'none' as const,
  AI_REQUEST_TIMEOUT_MS: 20_000,
  AI_MAX_TOKENS_PER_USER_DAY: 200_000,
  OPENAI_MODEL_FAST: 'gpt-4o-mini',
  OPENAI_MODEL_SMART: 'gpt-4o',
  OPENAI_MODEL_EMBEDDING: 'text-embedding-3-small',
  GEMINI_MODEL_FAST: 'gemini-2.0-flash',
  GEMINI_MODEL_SMART: 'gemini-2.0-pro',
  ANTHROPIC_MODEL_FAST: 'claude-haiku-4-5-20251001',
  ANTHROPIC_MODEL_SMART: 'claude-sonnet-5',
};

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

const build = (env: Record<string, unknown>, analyses: unknown = { tokensUsedToday: vi.fn() }) => {
  const log = logger();
  const service = new AiService(
    { env: { ...base, ...env } } as never,
    analyses as never,
    log as never,
  );
  return { service, log };
};

describe('picking a provider', () => {
  it('builds OpenAI', () => {
    const { service } = build({ OPENAI_API_KEY: 'sk-x' });
    expect(service.provider()?.name).toBe('openai');
  });

  it('builds Gemini — the case that used to silently do nothing', () => {
    const { service } = build({ AI_PRIMARY_PROVIDER: 'gemini', GEMINI_API_KEY: 'g' });
    expect(service.provider()?.name).toBe('gemini');
  });

  it('builds Anthropic — likewise', () => {
    const { service } = build({ AI_PRIMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' });
    expect(service.provider()?.name).toBe('anthropic');
  });

  it('refuses to start on a provider name with no implementation', () => {
    // Unreachable through the env schema, which is an enum — and reachable the
    // moment someone widens that enum and forgets this switch, which is exactly
    // how the silent version came to exist.
    expect(() => build({ AI_PRIMARY_PROVIDER: 'mistral' })).toThrow(/No implementation/);
  });

  it('is null with no key at all, which is an ordinary deployment', () => {
    const { service, log } = build({});

    expect(service.provider()).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.not_configured' }),
      expect.anything(),
    );
  });

  it('honours an explicit opt-out even with a key sitting in the environment', () => {
    // Running without AI has to be sayable. Before `none` existed the default of
    // `openai` counted as a selection, the env schema demanded a key for it, and
    // the no-AI deployment this class is written around could not boot.
    const { service } = build({ AI_PRIMARY_PROVIDER: 'none', OPENAI_API_KEY: 'sk-x' });

    expect(service.provider()).toBeNull();
  });

  it('says at boot whether embeddings are available', () => {
    // With Anthropic, search runs on keyword and trigram only. Nobody should
    // have to infer that from a provider name at three in the morning.
    const { log } = build({ AI_PRIMARY_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.configured', provider: 'anthropic', embeddings: false }),
      expect.anything(),
    );
  });

  it('says so when they are', () => {
    const { log } = build({ OPENAI_API_KEY: 'sk-x' });

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.configured', embeddings: true }),
      expect.anything(),
    );
  });
});

describe('the fallback', () => {
  it('is null when none is configured', () => {
    const { service } = build({ OPENAI_API_KEY: 'sk-x' });
    expect(service.secondary()).toBeNull();
  });

  it('is built when one is', () => {
    const { service } = build({
      OPENAI_API_KEY: 'sk-x',
      AI_FALLBACK_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'g',
    });

    expect(service.provider()?.name).toBe('openai');
    expect(service.secondary()?.name).toBe('gemini');
  });

  it('refuses an unimplemented fallback just as firmly as a primary', () => {
    expect(() => build({ OPENAI_API_KEY: 'sk-x', AI_FALLBACK_PROVIDER: 'mistral' })).toThrow(
      /No implementation/,
    );
  });

  it('can supply embeddings the primary does not have', () => {
    // "Anthropic for analysis, OpenAI for vectors" is a reasonable thing to
    // configure, and the processors resolve it in exactly this order.
    const { service } = build({
      AI_PRIMARY_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'a',
      AI_FALLBACK_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-x',
    });

    expect(canEmbed(service.provider())).toBe(false);
    expect(canEmbed(service.secondary())).toBe(true);
  });
});

describe('the token budget', () => {
  it('is unlimited when the ceiling is zero', async () => {
    const tokensUsedToday = vi.fn().mockResolvedValue(999_999_999);
    const { service } = build({ AI_MAX_TOKENS_PER_USER_DAY: 0 }, { tokensUsedToday });

    expect(await service.isOverBudget('user-1')).toBe(false);
    expect(tokensUsedToday).not.toHaveBeenCalled();
  });

  it('is spent at the ceiling, not past it', async () => {
    const { service } = build(
      { AI_MAX_TOKENS_PER_USER_DAY: 100 },
      { tokensUsedToday: vi.fn().mockResolvedValue(100) },
    );

    expect(await service.isOverBudget('user-1')).toBe(true);
  });

  it('fails open when the database is unreachable', async () => {
    // A cost control, not a security boundary: the blast radius of getting this
    // wrong is one user's tokens for one day, and the alternative is mail
    // arriving plain because of an unrelated hiccup.
    const { service, log } = build(
      {},
      { tokensUsedToday: vi.fn().mockRejectedValue(new Error('down')) },
    );

    expect(await service.isOverBudget('user-1')).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});
