import { type CheckResult, type Probe, metaErrorCode, metaErrorMessage } from './types.js';

/**
 * Turning probe results into instructions.
 *
 * Every function here is pure over a {@link Probe}, which is the point: the
 * remediation text is the deliverable, and text is the part that rots. A
 * network-free test can assert that a 190 says "your token expired" rather than
 * "request failed", and that assertion is what keeps the message useful a year
 * from now.
 */

/** The OAuth callback the API actually serves. Derived, never configured twice. */
export function googleRedirectUriFor(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/v1/oauth/google/callback`;
}

/** The Graph notification URL the API actually serves. */
export function microsoftRedirectUriFor(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/v1/oauth/microsoft/callback`;
}

/** Where Meta must be told to send webhooks. */
export function whatsappWebhookUrlFor(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/webhooks/whatsapp`;
}

/**
 * Whether this response came from Graph at all.
 *
 * A filtering proxy answers on Graph's behalf — an egress allowlist returns a
 * plain 403, a captive portal a 200 of HTML — and every status branch below
 * would then explain a Meta error that Meta never sent. "The token is missing
 * whatsapp_business_messaging" is a bad thing to tell someone whose real
 * problem is that their network will not route to facebook.com.
 *
 * Meta's own errors always carry the envelope, so its absence on a non-200 is
 * the tell.
 */
function notFromMeta(probe: Extract<Probe, { kind: 'response' }>): CheckResult | null {
  if (probe.status === 200) return null;
  if (metaErrorCode(probe.body) !== undefined || metaErrorMessage(probe.body) !== undefined) {
    return null;
  }

  const body = typeof probe.body === 'string' ? probe.body.slice(0, 120) : '';
  return {
    name: '',
    level: 'fail',
    detail: `Something other than Meta answered ${probe.status}${body ? ` — ${body}` : ''}`,
    fix: 'The response carries no Meta error envelope, so a proxy or egress filter is answering in Graph’s place. Allow graph.facebook.com outbound.',
  };
}

/**
 * `GET /{phone-number-id}` — does the token work, and is the id a number on it.
 *
 * The single most common thing wrong with a fresh setup, by a wide margin, is
 * an expired token: the one the Meta dashboard shows you on the API Setup tab
 * is temporary and lasts twenty-four hours, which is long enough to finish
 * setup, go to bed, and find it broken. The message says so, because "request
 * failed with 401" sends people to look at their phone number id.
 */
export function interpretPhoneNumber(probe: Probe): CheckResult {
  const name = 'WhatsApp number';

  if (probe.kind === 'unreachable') {
    return {
      name,
      level: 'fail',
      detail: `Could not reach graph.facebook.com — ${probe.error}`,
      fix: 'Check outbound network access. Everything else about WhatsApp is unverifiable until this call works.',
    };
  }

  const foreign = notFromMeta(probe);
  if (foreign) return { ...foreign, name };

  const code = metaErrorCode(probe.body);
  const message = metaErrorMessage(probe.body);

  if (probe.status === 200) {
    const body = probe.body as {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
    } | null;

    const number = body?.display_phone_number;
    if (!number) {
      return {
        name,
        level: 'fail',
        detail: 'Meta answered 200 but the response has no display_phone_number.',
        fix: 'The id resolved to something that is not a phone number. Re-copy WHATSAPP_PHONE_NUMBER_ID from WhatsApp → API Setup.',
      };
    }

    const parts = [number];
    if (body.verified_name) parts.push(`“${body.verified_name}”`);
    if (body.quality_rating) parts.push(`quality ${body.quality_rating}`);

    return { name, level: 'ok', detail: parts.join(', ') };
  }

  // 190 is the expired/revoked token, and it arrives as a 401 or a 400
  // depending on the endpoint, so the code is the thing to branch on.
  if (code === 190 || probe.status === 401) {
    return {
      name,
      level: 'fail',
      detail: message ?? 'The access token was rejected.',
      fix: 'WHATSAPP_ACCESS_TOKEN has expired or been revoked. The token on the API Setup tab is temporary and lasts 24 hours — for anything longer, create a System User in Business Settings and generate a permanent token with whatsapp_business_messaging.',
    };
  }

  if (code === 200 || code === 10 || probe.status === 403) {
    return {
      name,
      level: 'fail',
      detail: message ?? 'The token is not permitted to read that number.',
      fix: 'The token is missing the whatsapp_business_messaging permission, or the number belongs to a different business. Regenerate it against the right System User.',
    };
  }

  if (code === 100 || probe.status === 404) {
    return {
      name,
      level: 'fail',
      detail: message ?? 'Meta does not recognise that id.',
      fix: 'WHATSAPP_PHONE_NUMBER_ID is Meta’s opaque id from WhatsApp → API Setup — a long number, not the dialable phone number and not the WhatsApp Business Account id.',
    };
  }

  return {
    name,
    level: 'fail',
    detail: message ?? `Meta answered ${probe.status}.`,
    fix: 'Unexpected response. The message above is Meta’s own; the API Setup tab is where every value in it comes from.',
  };
}

/**
 * `GET /{waba-id}/subscribed_apps` — will Meta actually deliver webhooks here.
 *
 * The check people most need and least expect. Registering a callback URL in
 * the app dashboard makes the handshake succeed and delivers nothing: the app
 * must also be subscribed to the WhatsApp Business Account. Setup then looks
 * complete from every screen, and no message ever arrives.
 *
 * A token without `whatsapp_business_management` cannot answer this question,
 * which is a warning rather than a failure — messaging works on the narrower
 * permission, so refusing to run would be wrong.
 */
export function interpretSubscribedApps(probe: Probe): CheckResult {
  const name = 'Webhook subscription';

  if (probe.kind === 'unreachable') {
    return {
      name,
      level: 'warn',
      detail: `Could not reach graph.facebook.com — ${probe.error}`,
      fix: 'Unverified. If messages do not arrive, check WhatsApp → Configuration → Webhook fields.',
    };
  }

  const foreign = notFromMeta(probe);
  // A warning here rather than a failure, matching the rest of this check: the
  // subscription may well be fine, we simply could not look.
  if (foreign) return { ...foreign, name, level: 'warn' };

  if (probe.status === 200) {
    const data = (probe.body as { data?: unknown[] } | null)?.data;
    if (Array.isArray(data) && data.length > 0) {
      return { name, level: 'ok', detail: `${data.length} app subscribed to this WABA` };
    }
    return {
      name,
      level: 'fail',
      detail: 'No app is subscribed to this WhatsApp Business Account.',
      fix: 'Meta will not deliver a single webhook until you subscribe. WhatsApp → Configuration → Webhooks → Manage, and tick the “messages” field.',
    };
  }

  const message = metaErrorMessage(probe.body);
  const code = metaErrorCode(probe.body);

  if (code === 200 || code === 10 || probe.status === 403 || probe.status === 401) {
    return {
      name,
      level: 'warn',
      detail: message ?? 'The token may not read subscriptions.',
      fix: 'Add whatsapp_business_management to the token to check this automatically, or confirm by eye under WhatsApp → Configuration that “messages” is subscribed.',
    };
  }

  return {
    name,
    level: 'warn',
    detail: message ?? `Meta answered ${probe.status}.`,
    fix: 'Could not confirm the subscription. Check WhatsApp → Configuration → Webhook fields.',
  };
}

/**
 * Is the API running on this machine at all.
 *
 * Only asked when the public URL is somewhere else, because it exists to split
 * one symptom in two. "Nothing answered at that URL" has two completely
 * different causes — the process is not running, or the tunnel is not reaching
 * it — and they send you to different places. Answering both at once turns the
 * pair of results into a diagnosis.
 */
export function interpretLocalApi(probe: Probe, port: number): CheckResult {
  const name = 'API process';

  if (probe.kind === 'unreachable') {
    return {
      name,
      level: 'fail',
      detail: `Nothing listening on localhost:${port}`,
      fix: 'Start it with `pnpm dev`, which runs the API, the worker and the dashboard together.',
    };
  }

  // Any answer proves a listener. A 503 means the API is up and a dependency is
  // not, which the Postgres and Redis checks above have already named.
  return {
    name,
    level: 'ok',
    detail:
      probe.status === 200
        ? `listening on ${port}`
        : `listening on ${port} (not ready: ${probe.status})`,
  };
}

/**
 * The verify handshake, performed against our own API exactly as Meta performs it.
 *
 * This is the one check that tests the whole inbound path end to end — the
 * tunnel resolves, TLS terminates, the request reaches this codebase, and the
 * verify token the running process holds matches the one in the file being
 * read. A stale process still holding last week's token is invisible every
 * other way, and it is the reason the handshake is performed rather than the
 * token compared as a string.
 *
 * `localApiUp` is what makes an unreachable URL actionable. Knowing the process
 * is answering on localhost while the public URL is not turns "something is
 * wrong" into "your tunnel is down", which is a different afternoon.
 */
export function interpretWebhookHandshake(
  probe: Probe,
  challenge: string,
  options: { localApiUp?: boolean | undefined } = {},
): CheckResult {
  const name = 'Webhook endpoint';

  if (probe.kind === 'unreachable') {
    return {
      name,
      level: 'fail',
      detail: `Nothing answered at that URL — ${probe.error}`,
      fix:
        options.localApiUp === true
          ? 'The API is answering on localhost, so this is the tunnel rather than the app. Is it still running? A quick tunnel’s hostname changes every restart, and Meta has the old one.'
          : options.localApiUp === false
            ? 'The API is not running either — start it with `pnpm dev` before looking at the tunnel.'
            : 'API_BASE_URL must be reachable from the public internet, because Meta calls it. If it is a tunnel, is the tunnel still running? Its URL changes every restart unless it is a named tunnel.',
    };
  }

  if (probe.status === 200) {
    const body = typeof probe.body === 'string' ? probe.body : JSON.stringify(probe.body);
    if (body === challenge) {
      return { name, level: 'ok', detail: 'Handshake echoed the challenge' };
    }
    return {
      name,
      level: 'fail',
      detail: 'Something answered 200 but did not echo the challenge.',
      fix: 'Another service is on that URL — a tunnel pointed at the dashboard on :3000 rather than the API on :3001 is the usual cause.',
    };
  }

  if (probe.status === 403) {
    return {
      name,
      level: 'fail',
      detail: 'The API rejected our own verify token.',
      fix: 'The running process holds a different WHATSAPP_WEBHOOK_VERIFY_TOKEN than the one in .env — restart it. If it was restarted, the same value must also be typed into Meta’s webhook configuration.',
    };
  }

  return {
    name,
    level: 'fail',
    detail: `The endpoint answered ${probe.status}.`,
    fix: 'Meta treats anything but a 200 echoing the challenge as a failed verification and will not save the webhook.',
  };
}

/**
 * Google OAuth, checked as configuration rather than over the network.
 *
 * `redirect_uri_mismatch` is the error every Google integration hits first, and
 * it is worth catching here because Google's own message names the URI it
 * received without naming the one it expected. The API serves exactly one
 * callback path, so the correct value is derivable — and a check that derives
 * it can print it ready to paste.
 */
export function interpretGoogleOAuth(input: {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  redirectUri?: string | undefined;
  apiBaseUrl: string;
}): CheckResult {
  const name = 'Gmail OAuth client';
  const expected = googleRedirectUriFor(input.apiBaseUrl);

  if (!input.clientId || !input.clientSecret) {
    return {
      name,
      level: 'fail',
      detail: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set.',
      fix: `No mailbox can be connected without them. Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (Web application), redirect ${expected}`,
    };
  }

  if (!input.redirectUri) {
    return {
      name,
      level: 'fail',
      detail: 'GOOGLE_REDIRECT_URI is not set.',
      fix: `Set it to ${expected} — and add the identical string to the OAuth client’s authorised redirect URIs.`,
    };
  }

  if (input.redirectUri !== expected) {
    return {
      name,
      level: 'fail',
      detail: `GOOGLE_REDIRECT_URI is ${input.redirectUri}, but the API serves ${expected}.`,
      fix: 'Google compares this string exactly — a trailing slash or http instead of https is a mismatch. Make both this variable and the OAuth client match the URL above.',
    };
  }

  return { name, level: 'ok', detail: expected };
}

/**
 * How new mail will actually reach the user, which is not always how the README says.
 *
 * Push needs a Pub/Sub topic, a push subscription and a role grant to Google's
 * own service account — comfortably the longest part of setting this up. The
 * poller exists precisely so that work is optional, so the absence of a topic
 * is a supported configuration and not an error. It is still a warning, because
 * "under five seconds" quietly becomes "within a few minutes" and someone
 * watching their phone deserves to know which they are testing.
 */
export function interpretGmailDelivery(input: {
  pubsubTopic?: string | undefined;
  pollIntervalMs: number;
}): CheckResult {
  const name = 'Gmail delivery';

  if (input.pubsubTopic) {
    return { name, level: 'ok', detail: `push via ${input.pubsubTopic}` };
  }

  const minutes = Math.round(input.pollIntervalMs / 60_000);
  return {
    name,
    level: 'warn',
    detail: `polling every ${minutes} minute${minutes === 1 ? '' : 's'} — no Pub/Sub topic configured`,
    fix: 'Mail arrives within the poll interval rather than in seconds. That is a supported way to run and needs nothing further; for near-instant delivery, set GOOGLE_PUBSUB_TOPIC and point a push subscription at /webhooks/gmail.',
  };
}

/**
 * Whether the AI features are switched on at all.
 *
 * Only one question is left here, because the environment schema already
 * refuses to boot when a provider is named and its key is empty — a check that
 * repeated it would be a branch that can never run. What the schema cannot see
 * is a deliberate `none`, which is a supported configuration and worth stating
 * out loud: an inbox with no summaries looks broken to someone who does not
 * know it was configured that way.
 */
export function interpretAiConfig(primary: string): CheckResult | null {
  if (primary !== 'none') return null;

  return {
    name: 'AI provider',
    level: 'warn',
    detail: 'disabled',
    fix: 'Summaries, drafting, translation and voice notes are off. Set AI_PRIMARY_PROVIDER and its key to turn them on.',
  };
}

/**
 * The key, tried against the provider.
 *
 * This is the half the schema cannot do. A key that is present and correctly
 * shaped can still be revoked, or belong to an account with no credit left —
 * and the second is the quiet one: OpenAI answers 429 `insufficient_quota` to
 * every request, the worker treats each as a transient failure, and the user
 * gets an inbox with no summaries and no explanation. A billing problem is not
 * something to discover from a log line.
 */
export function interpretAiKey(probe: Probe, provider: string): CheckResult {
  const name = 'AI provider';

  if (probe.kind === 'unreachable') {
    return {
      name,
      level: 'warn',
      detail: `${provider} — could not reach it (${probe.error})`,
      fix: 'Unverified. If summaries never appear, this is the first thing to re-check.',
    };
  }

  if (probe.status === 200) return { name, level: 'ok', detail: `${provider} — key accepted` };

  if (probe.status === 401 || probe.status === 403) {
    return {
      name,
      level: 'fail',
      detail: `${provider} rejected the key.`,
      fix: `${provider.toUpperCase()}_API_KEY is wrong, revoked, or belongs to a different organisation.`,
    };
  }

  if (probe.status === 429) {
    // Two very different conditions behind one status. A rate limit passes on
    // its own; an exhausted balance never does.
    const body = probe.body as { error?: { type?: string; code?: string } } | null;
    const kind = body?.error?.type ?? body?.error?.code ?? '';

    if (/quota|billing|credit/i.test(kind)) {
      return {
        name,
        level: 'fail',
        detail: `${provider} accepted the key but the account is out of credit.`,
        fix: 'Every summary, draft and translation will fail. Add billing to the account, or set AI_PRIMARY_PROVIDER=none to run without them deliberately.',
      };
    }

    return {
      name,
      level: 'warn',
      detail: `${provider} rate-limited this check.`,
      fix: 'The key works. If this persists under load, the account tier is the limit.',
    };
  }

  return {
    name,
    level: 'warn',
    detail: `${provider} answered ${probe.status}.`,
    fix: 'Could not confirm the key. Summaries may or may not work.',
  };
}

/**
 * Whether the dashboard can reach the API from a browser.
 *
 * `NEXT_PUBLIC_API_BASE_URL` does two jobs: it is the base every request goes
 * to, and `middleware.ts` derives the CSP `connect-src` from it. Point it
 * somewhere the API is not and the failure is uniquely unhelpful — a policy
 * violation in the console and **nothing at all in the network tab**, because
 * the request never leaves the page.
 *
 * Two answers are correct, which is why this cannot be a string equality: the
 * public URL, or `localhost:API_PORT` when the browser is on the same machine
 * as the API. Anything else is a dashboard that silently cannot sign in.
 *
 * Next inlines `NEXT_PUBLIC_*` at build time, so fixing it needs a rebuild
 * rather than a restart — worth saying, because a restart looks like it should
 * be enough and is not.
 */
export function interpretDashboardWiring(input: {
  configured?: string | undefined;
  apiBaseUrl: string;
  apiPort: number;
}): CheckResult {
  const name = 'Dashboard → API';
  const trim = (u: string) => u.replace(/\/+$/, '');
  const local = `http://localhost:${input.apiPort}`;

  if (!input.configured) {
    return {
      name,
      level: 'warn',
      detail: `NEXT_PUBLIC_API_BASE_URL is unset — the dashboard will use ${local}`,
      fix: `Right only if you open the dashboard on the same machine as the API. Set it to ${trim(input.apiBaseUrl)} if you will not.`,
    };
  }

  const configured = trim(input.configured);
  if (configured === trim(input.apiBaseUrl)) {
    return { name, level: 'ok', detail: configured };
  }

  if (configured === local || configured === `http://127.0.0.1:${input.apiPort}`) {
    return {
      name,
      level: 'ok',
      detail: `${configured} — same machine as the API`,
    };
  }

  return {
    name,
    level: 'fail',
    detail: `NEXT_PUBLIC_API_BASE_URL is ${configured}, which is neither ${trim(input.apiBaseUrl)} nor ${local}.`,
    fix: 'The dashboard will fail every request with a Content-Security-Policy violation and nothing in the network tab, because connect-src is derived from this value. Next inlines it at build time, so change it and rebuild — a restart is not enough.',
  };
}

/** Postgres, and the two extensions the schema is written against. */
export function interpretDatabase(input: {
  reachable: boolean;
  error?: string | undefined;
  extensions?: string[] | undefined;
  pendingMigrations?: number | undefined;
}): CheckResult[] {
  const results: CheckResult[] = [];

  if (!input.reachable) {
    return [
      {
        name: 'Postgres',
        level: 'fail',
        detail: input.error ?? 'unreachable',
        fix: 'Start it with `docker compose up -d postgres`, and check DATABASE_URL.',
      },
    ];
  }

  results.push({ name: 'Postgres', level: 'ok', detail: 'reachable' });

  const installed = new Set(input.extensions ?? []);
  const missing = ['vector', 'pg_trgm'].filter((e) => !installed.has(e));
  if (missing.length > 0) {
    results.push({
      name: 'Postgres extensions',
      level: 'fail',
      detail: `missing ${missing.join(', ')}`,
      fix: 'Semantic and fuzzy search depend on them. The compose image installs both from infra/docker/postgres/init — a database created before that file existed will not have them.',
    });
  } else {
    results.push({ name: 'Postgres extensions', level: 'ok', detail: 'vector, pg_trgm' });
  }

  if (input.pendingMigrations && input.pendingMigrations > 0) {
    results.push({
      name: 'Migrations',
      level: 'fail',
      detail: `${input.pendingMigrations} not applied`,
      fix: 'Run `pnpm db:migrate`. The code will query columns that do not exist yet.',
    });
  } else {
    results.push({ name: 'Migrations', level: 'ok', detail: 'up to date' });
  }

  return results;
}

/** Redis, which is where every queue lives. */
export function interpretRedis(input: {
  reachable: boolean;
  error?: string | undefined;
}): CheckResult {
  if (input.reachable) return { name: 'Redis', level: 'ok', detail: 'reachable' };
  return {
    name: 'Redis',
    level: 'fail',
    detail: input.error ?? 'unreachable',
    fix: 'Every queue lives here — nothing is ingested, analysed or sent without it. `docker compose up -d redis`, and check REDIS_URL.',
  };
}

/**
 * The one check that is not about whether something is broken.
 *
 * Outbound mail goes through the connected mailbox's own API with the user's
 * OAuth token, in every environment. There is no development mode that
 * intercepts it, and this repository's own documentation claimed otherwise for
 * long enough that the claim is worth actively contradicting: a reply typed
 * into WhatsApp while testing reaches the real recipient, from the real
 * address, and cannot be recalled after the fifteen-second window.
 */
export function outboundIsLive(nodeEnv: string): CheckResult {
  return {
    name: 'Outbound mail',
    level: 'warn',
    detail: `live — sends go to real recipients, including in ${nodeEnv}`,
    fix: 'There is no capture or sandbox. Test against an address you control; `undo` takes a message back for fifteen seconds and no longer.',
  };
}
