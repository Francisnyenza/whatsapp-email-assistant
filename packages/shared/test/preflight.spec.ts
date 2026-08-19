import { describe, it, expect } from 'vitest';
import {
  interpretPhoneNumber,
  interpretSubscribedApps,
  interpretWebhookHandshake,
  interpretLocalApi,
  interpretDashboardWiring,
  interpretGoogleOAuth,
  interpretGmailDelivery,
  interpretAiConfig,
  interpretAiKey,
  interpretDatabase,
  interpretRedis,
  outboundIsLive,
  googleRedirectUriFor,
  whatsappWebhookUrlFor,
} from '../src/preflight/interpret.js';
import { renderReport, worstLevel, exitCodeFor } from '../src/preflight/report.js';
import type { CheckResult, Probe } from '../src/preflight/types.js';

/**
 * The preflight check.
 *
 * What is being tested is the **advice**, not the plumbing. Every failure this
 * product has on a fresh install is silent and looks identical from the
 * outside — nothing arrives — so the value of the check is entirely in whether
 * it names the right thing to change. "Request failed with status 401" sends
 * someone to re-read their phone number id for an hour; "your token expired,
 * the dashboard one lasts 24 hours" ends it in a minute.
 *
 * So these assert on the text. That looks brittle and is the point: the text is
 * the product, and a rewrite that loses the useful sentence should fail
 * something.
 */

const response = (status: number, body: unknown): Probe => ({ kind: 'response', status, body });
const metaError = (code: number, message: string) => ({ error: { code, message } });

describe('the WhatsApp number', () => {
  it('reports the number, name and quality when the token works', () => {
    const result = interpretPhoneNumber(
      response(200, {
        display_phone_number: '+1 555 0100',
        verified_name: 'Acme',
        quality_rating: 'GREEN',
      }),
    );

    expect(result.level).toBe('ok');
    expect(result.detail).toContain('+1 555 0100');
    expect(result.detail).toContain('Acme');
    expect(result.detail).toContain('GREEN');
  });

  it('says the token expired, and that the dashboard one lasts a day', () => {
    // The single most common failure on a setup that worked yesterday. Anything
    // that does not mention the 24 hours leaves the operator regenerating the
    // same temporary token.
    const result = interpretPhoneNumber(
      response(401, metaError(190, 'Error validating access token: Session has expired')),
    );

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/24 hours/);
    expect(result.fix).toMatch(/System User/);
  });

  it('recognises the expired token by code even when the status is not 401', () => {
    // Graph returns 190 under a 400 on some edges. Branching on the status
    // alone would file it as "unexpected response".
    const result = interpretPhoneNumber(response(400, metaError(190, 'Session has expired')));

    expect(result.fix).toMatch(/24 hours/);
  });

  it('says which id it wanted when the id is wrong', () => {
    // People reach for the dialable number or the WABA id. Both produce this.
    const result = interpretPhoneNumber(
      response(400, metaError(100, 'Unsupported get request. Object does not exist')),
    );

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/API Setup/);
    expect(result.fix).toMatch(/not the dialable phone number/);
  });

  it('names the missing permission on a 403', () => {
    const result = interpretPhoneNumber(response(403, metaError(200, 'Permissions error')));

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/whatsapp_business_messaging/);
  });

  it('does not call a 200 with no number a success', () => {
    const result = interpretPhoneNumber(response(200, { id: '123' }));

    expect(result.level).toBe('fail');
  });

  it('reports an unreachable Graph as its own problem', () => {
    const result = interpretPhoneNumber({ kind: 'unreachable', error: 'ENOTFOUND' });

    expect(result.level).toBe('fail');
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('blames the network when the 403 did not come from Meta', () => {
    // An egress allowlist answers in Graph's place with a plain-text 403.
    // Reading that as a permission error sends someone to regenerate a token
    // that was never the problem.
    const result = interpretPhoneNumber(response(403, 'Host not in allowlist: graph.facebook.com'));

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/proxy or egress filter/);
    expect(result.fix).not.toMatch(/whatsapp_business_messaging/);
  });

  it('keeps the Meta reading when the envelope is there', () => {
    // The guard must not swallow a real permission error.
    expect(interpretPhoneNumber(response(403, metaError(200, 'Permissions error'))).fix).toMatch(
      /whatsapp_business_messaging/,
    );
  });

  it('passes Meta’s own message through when it does not recognise the error', () => {
    // Better than a generic line: Meta's message is usually specific, and
    // inventing our own for an unknown code would lose it.
    const result = interpretPhoneNumber(response(418, metaError(9999, 'Something novel')));

    expect(result.detail).toBe('Something novel');
  });
});

describe('the webhook subscription', () => {
  it('fails when no app is subscribed, because nothing will ever be delivered', () => {
    // The gap nobody expects: registering the callback URL makes the handshake
    // pass and delivers nothing. Every screen looks configured.
    const result = interpretSubscribedApps(response(200, { data: [] }));

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/Configuration/);
    expect(result.fix).toMatch(/messages/);
  });

  it('passes when an app is subscribed', () => {
    const result = interpretSubscribedApps(
      response(200, { data: [{ whatsapp_business_api_data: {} }] }),
    );

    expect(result.level).toBe('ok');
  });

  it('warns rather than fails when the token cannot read subscriptions', () => {
    // Messaging works on the narrower permission, so refusing to run would be
    // wrong — this is genuinely "could not check".
    const result = interpretSubscribedApps(response(403, metaError(200, 'Permissions error')));

    expect(result.level).toBe('warn');
    expect(result.fix).toMatch(/whatsapp_business_management/);
  });

  it('warns when Graph is unreachable', () => {
    expect(interpretSubscribedApps({ kind: 'unreachable', error: 'timeout' }).level).toBe('warn');
  });
});

describe('the webhook handshake', () => {
  it('passes only when the challenge comes back', () => {
    expect(interpretWebhookHandshake(response(200, 'abc123'), 'abc123').level).toBe('ok');
  });

  it('fails when something else answers on that URL', () => {
    // A tunnel pointed at the dashboard rather than the API returns 200 and
    // HTML. Checking the status alone would call that working.
    const result = interpretWebhookHandshake(response(200, '<!doctype html>'), 'abc123');

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/3000/);
  });

  it('reads a 403 as the running process holding a different token', () => {
    // We send the token we just read from the environment. Being refused means
    // the process was started before the file was edited.
    const result = interpretWebhookHandshake(response(403, 'Forbidden'), 'abc123');

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/restart/i);
  });

  it('blames the tunnel when nothing answers at all', () => {
    const result = interpretWebhookHandshake({ kind: 'unreachable', error: 'ECONNREFUSED' }, 'x');

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/tunnel/);
  });
});

describe('is the API even running', () => {
  it('passes on any answer, because a listener is the whole question', () => {
    // A 503 means the API is up and a dependency is not, which the Postgres and
    // Redis rows have already named. Reading it as "API down" would send
    // someone to restart a process that is working.
    expect(interpretLocalApi(response(200, {}), 3001).level).toBe('ok');
    expect(interpretLocalApi(response(503, {}), 3001).level).toBe('ok');
  });

  it('names the port and the command when nothing is listening', () => {
    const result = interpretLocalApi({ kind: 'unreachable', error: 'ECONNREFUSED' }, 3001);

    expect(result.level).toBe('fail');
    expect(result.detail).toContain('3001');
    expect(result.fix).toContain('pnpm dev');
  });
});

describe('splitting a dead tunnel from a dead process', () => {
  const dead = { kind: 'unreachable', error: 'ECONNREFUSED' } as const;

  it('blames the tunnel when the process is answering locally', () => {
    // The pair of results is the diagnosis. One says nothing answered
    // publicly, the other says the process is fine — together that is
    // "your tunnel is down" rather than "something is wrong".
    const result = interpretWebhookHandshake(dead, 'x', { localApiUp: true });

    expect(result.fix).toMatch(/tunnel rather than the app/);
  });

  it('sends you to start the API when that is not running either', () => {
    const result = interpretWebhookHandshake(dead, 'x', { localApiUp: false });

    expect(result.fix).toMatch(/not running either/);
    expect(result.fix).toContain('pnpm dev');
  });

  it('falls back to the general advice when the split was not checked', () => {
    // API_BASE_URL already points at localhost, so there is no second place to
    // look and no split to make.
    expect(interpretWebhookHandshake(dead, 'x').fix).toMatch(/reachable from the public internet/);
  });
});

describe('the dashboard reaching the API', () => {
  const apiPort = 3001;

  it('passes when it names the public URL', () => {
    const result = interpretDashboardWiring({
      configured: 'https://api.example.com',
      apiBaseUrl: 'https://api.example.com',
      apiPort,
    });

    expect(result.level).toBe('ok');
  });

  it('passes on localhost, because the browser is usually on this machine', () => {
    // Two answers are correct here, which is why it cannot be string equality.
    for (const host of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
      const result = interpretDashboardWiring({
        configured: host,
        apiBaseUrl: 'https://api.example.com',
        apiPort,
      });
      expect(result.level).toBe('ok');
    }
  });

  it('fails when it points somewhere the API is not', () => {
    // The worst failure to debug in the product: a CSP violation in the console
    // and nothing whatsoever in the network tab, because connect-src is derived
    // from this value and the request never leaves the page.
    const result = interpretDashboardWiring({
      configured: 'https://stale-tunnel.example.com',
      apiBaseUrl: 'https://api.example.com',
      apiPort,
    });

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/Content-Security-Policy/);
    expect(result.fix).toMatch(/rebuild/);
  });

  it('catches localhost on the wrong port', () => {
    // Changing API_PORT without changing this is a dashboard that cannot sign
    // in, and nothing else reports it.
    const result = interpretDashboardWiring({
      configured: 'http://localhost:3001',
      apiBaseUrl: 'https://api.example.com',
      apiPort: 4000,
    });

    expect(result.level).toBe('fail');
  });

  it('ignores a trailing slash rather than failing on one', () => {
    const result = interpretDashboardWiring({
      configured: 'https://api.example.com/',
      apiBaseUrl: 'https://api.example.com',
      apiPort,
    });

    expect(result.level).toBe('ok');
  });

  it('warns when unset, saying what the default assumes', () => {
    const result = interpretDashboardWiring({
      apiBaseUrl: 'https://api.example.com',
      apiPort,
    });

    expect(result.level).toBe('warn');
    expect(result.detail).toContain('http://localhost:3001');
    expect(result.fix).toContain('https://api.example.com');
  });
});

describe('the Gmail OAuth client', () => {
  const apiBaseUrl = 'https://api.example.com';

  it('derives the callback the API actually serves', () => {
    expect(googleRedirectUriFor(apiBaseUrl)).toBe(
      'https://api.example.com/v1/oauth/google/callback',
    );
  });

  it('does not double the slash when the base URL has one', () => {
    expect(googleRedirectUriFor('https://api.example.com/')).toBe(
      'https://api.example.com/v1/oauth/google/callback',
    );
  });

  it('fails when the client is not configured, and prints the redirect to paste', () => {
    const result = interpretGoogleOAuth({ apiBaseUrl });

    expect(result.level).toBe('fail');
    expect(result.fix).toContain('https://api.example.com/v1/oauth/google/callback');
  });

  it('catches a redirect URI that differs by a trailing slash', () => {
    // `redirect_uri_mismatch` is the first error every Google integration hits,
    // and Google's own message names the URI it received without naming the one
    // it expected.
    const result = interpretGoogleOAuth({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://api.example.com/v1/oauth/google/callback/',
      apiBaseUrl,
    });

    expect(result.level).toBe('fail');
    expect(result.detail).toContain('but the API serves');
  });

  it('passes when they match exactly', () => {
    const result = interpretGoogleOAuth({
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: googleRedirectUriFor(apiBaseUrl),
      apiBaseUrl,
    });

    expect(result.level).toBe('ok');
  });
});

describe('how mail will actually arrive', () => {
  it('reports push when a topic is configured', () => {
    const result = interpretGmailDelivery({
      pubsubTopic: 'projects/p/topics/t',
      pollIntervalMs: 120_000,
    });

    expect(result.level).toBe('ok');
    expect(result.detail).toContain('projects/p/topics/t');
  });

  it('warns with the real interval when polling, rather than claiming seconds', () => {
    // Supported, not broken — but the README promises five seconds, and someone
    // watching their phone should know which of the two they are testing.
    const result = interpretGmailDelivery({ pollIntervalMs: 120_000 });

    expect(result.level).toBe('warn');
    expect(result.detail).toContain('2 minutes');
    expect(result.fix).toMatch(/supported way to run/);
  });

  it('says minute, not minutes, at one', () => {
    expect(interpretGmailDelivery({ pollIntervalMs: 60_000 }).detail).toContain('1 minute —');
  });
});

describe('the AI provider', () => {
  it('warns when AI is off, listing what is off with it', () => {
    const result = interpretAiConfig('none');

    expect(result?.level).toBe('warn');
    expect(result?.fix).toMatch(/Summaries/);
  });

  it('says nothing about configuration when a provider is selected', () => {
    // The environment schema already refuses to boot when a provider is named
    // and its key is empty, so a check repeating that would be a branch that
    // can never run. The live probe below is the part the schema cannot do.
    expect(interpretAiConfig('openai')).toBeNull();
  });

  it('accepts a key the provider accepted', () => {
    expect(interpretAiKey(response(200, { data: [] }), 'openai').level).toBe('ok');
  });

  it('fails on a rejected key and names the variable', () => {
    const result = interpretAiKey(
      response(401, { error: { message: 'Incorrect API key' } }),
      'openai',
    );

    expect(result.level).toBe('fail');
    expect(result.fix).toContain('OPENAI_API_KEY');
  });

  it('treats an exhausted balance as a failure, not a rate limit', () => {
    // The quiet one. A valid key with no credit answers 429 to every request,
    // the worker retries each as transient, and the user gets an inbox with no
    // summaries and no explanation.
    const result = interpretAiKey(
      response(429, {
        error: { type: 'insufficient_quota', message: 'exceeded your current quota' },
      }),
      'openai',
    );

    expect(result.level).toBe('fail');
    expect(result.detail).toMatch(/out of credit/);
  });

  it('treats an ordinary rate limit as a warning, because the key works', () => {
    const result = interpretAiKey(
      response(429, { error: { type: 'rate_limit_error' } }),
      'anthropic',
    );

    expect(result.level).toBe('warn');
  });

  it('warns rather than fails when the provider cannot be reached', () => {
    expect(interpretAiKey({ kind: 'unreachable', error: 'timeout' }, 'gemini').level).toBe('warn');
  });
});

describe('the local services', () => {
  it('reports one failure, not three, when Postgres is down', () => {
    // Extensions and migrations are unknowable without a connection, and three
    // red lines for one cause is how a report stops being read.
    const results = interpretDatabase({ reachable: false, error: 'ECONNREFUSED' });

    expect(results).toHaveLength(1);
    expect(results[0]!.level).toBe('fail');
  });

  it('names the extension that is missing', () => {
    const results = interpretDatabase({ reachable: true, extensions: ['plpgsql', 'pg_trgm'] });

    expect(results.find((r) => r.name === 'Postgres extensions')).toMatchObject({
      level: 'fail',
      detail: 'missing vector',
    });
  });

  it('fails on an unapplied migration', () => {
    const results = interpretDatabase({
      reachable: true,
      extensions: ['vector', 'pg_trgm'],
      pendingMigrations: 2,
    });

    expect(results.find((r) => r.name === 'Migrations')).toMatchObject({ level: 'fail' });
  });

  it('passes a healthy database', () => {
    const results = interpretDatabase({
      reachable: true,
      extensions: ['vector', 'pg_trgm'],
      pendingMigrations: 0,
    });

    expect(results.every((r) => r.level === 'ok')).toBe(true);
  });

  it('says what stops working when Redis is down', () => {
    const result = interpretRedis({ reachable: false, error: 'ECONNREFUSED' });

    expect(result.level).toBe('fail');
    expect(result.fix).toMatch(/queue/);
  });
});

describe('outbound mail', () => {
  it('warns that sends are live, in production and out of it', () => {
    // This repository's own docs claimed development mail was captured by
    // Mailpit. Nothing in the send path does that — Gmail and Graph are called
    // with the user's token whatever NODE_ENV says — and someone testing on the
    // strength of that claim mails a real person.
    for (const env of ['development', 'production']) {
      const result = outboundIsLive(env);
      expect(result.level).toBe('warn');
      expect(result.detail).toContain('real recipients');
    }
  });

  it('mentions the undo window, since that is the only recall there is', () => {
    expect(outboundIsLive('development').fix).toMatch(/fifteen seconds/);
  });
});

describe('the webhook URL helper', () => {
  it('matches the path the API registers', () => {
    expect(whatsappWebhookUrlFor('https://api.example.com')).toBe(
      'https://api.example.com/webhooks/whatsapp',
    );
  });
});

describe('the report', () => {
  const ok: CheckResult = { name: 'A', level: 'ok', detail: 'fine' };
  const warn: CheckResult = { name: 'B', level: 'warn', detail: 'odd', fix: 'consider this' };
  const fail: CheckResult = { name: 'C', level: 'fail', detail: 'broken', fix: 'do this' };

  it('takes the worst level', () => {
    expect(worstLevel([ok, warn, fail])).toBe('fail');
    expect(worstLevel([ok, warn])).toBe('warn');
    expect(worstLevel([ok])).toBe('ok');
    expect(worstLevel([])).toBe('ok');
  });

  it('exits non-zero only on a failure', () => {
    // A warning must not fail a script. Polling instead of push and AI switched
    // off are both supported, and treating them as broken makes the check
    // useless in the place it helps most — the step before a deploy.
    expect(exitCodeFor('warn')).toBe(0);
    expect(exitCodeFor('ok')).toBe(0);
    expect(exitCodeFor('fail')).toBe(1);
  });

  it('prints the fix under every check that has one', () => {
    const text = renderReport([{ title: 'Things', results: [ok, warn, fail] }]);

    expect(text).toContain('do this');
    expect(text).toContain('consider this');
  });

  it('counts the failures in the closing line', () => {
    const text = renderReport([{ title: 'Things', results: [fail, fail] }]);

    expect(text).toContain('2 checks failed');
  });

  it('says ready when nothing failed, and still mentions the warnings', () => {
    const text = renderReport([{ title: 'Things', results: [ok, warn] }]);

    expect(text).toContain('Ready.');
    expect(text).toContain('1 warning');
  });

  it('says ready with nothing else when everything passed', () => {
    expect(renderReport([{ title: 'Things', results: [ok] }])).toContain('Ready.\n');
  });

  it('skips a section with no checks rather than printing an empty heading', () => {
    const text = renderReport([
      { title: 'Empty', results: [] },
      { title: 'Things', results: [ok] },
    ]);

    expect(text).not.toContain('Empty');
  });

  it('ends with a newline', () => {
    expect(renderReport([{ title: 'Things', results: [ok] }]).endsWith('\n')).toBe(true);
  });
});
