import 'reflect-metadata';
import { PrismaClient } from '@wea/db';
import {
  loadEnv,
  renderReport,
  worstLevel,
  exitCodeFor,
  interpretPhoneNumber,
  interpretSubscribedApps,
  interpretWebhookHandshake,
  interpretGoogleOAuth,
  interpretGmailDelivery,
  interpretAiConfig,
  interpretAiKey,
  interpretDatabase,
  interpretRedis,
  outboundIsLive,
  whatsappWebhookUrlFor,
  POLL_INTERVAL_MS,
  type CheckResult,
  type Probe,
  type ReportSection,
} from '@wea/shared';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

/**
 * `pnpm doctor` — the check that runs before the first message.
 *
 * Every failure mode this product has on a fresh install is silent. The
 * environment schema refuses to boot on a variable that is missing or the wrong
 * shape, which is the easy half; the hard half is a variable that is perfectly
 * well-formed and wrong — a token that expired overnight, a WABA nobody
 * subscribed the app to, a redirect URI with a trailing slash. None of those
 * raise anything. The system starts, reports itself healthy, and never delivers
 * a message, and the operator is left reading logs that say nothing happened.
 *
 * So this talks to the actual services and reports what to change. It is a
 * shell around pure interpreters in `@wea/shared`: everything here is I/O and
 * everything that decides what a result *means* is tested without a network.
 *
 * Read-only, always. It sends no WhatsApp message, writes no row, and starts no
 * OAuth flow — a diagnostic that has side effects is one people stop running.
 */

/** Bounded so a hung tunnel cannot hang the whole check. */
const PROBE_TIMEOUT_MS = 10_000;

async function probe(url: string, init?: RequestInit): Promise<Probe> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON. The webhook handshake echoes a bare string, so this is a
      // normal outcome rather than a failure — keep the text.
    }

    return { kind: 'response', status: response.status, body };
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) };
  }
}

async function checkDatabase(url: string): Promise<CheckResult[]> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const extensions = await prisma.$queryRawUnsafe<Array<{ extname: string }>>(
      'SELECT extname FROM pg_extension',
    );

    // Prisma records every migration it has applied; anything in the directory
    // and not in this table is pending. Counting failed ones too — a migration
    // that rolled back leaves the schema half-shaped, which is worse than one
    // that never ran.
    const pending = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL',
    );

    return interpretDatabase({
      reachable: true,
      extensions: extensions.map((e) => e.extname),
      pendingMigrations: Number(pending[0]?.count ?? 0),
    });
  } catch (err) {
    return interpretDatabase({
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function checkRedis(url: string): Promise<CheckResult> {
  // `lazyConnect` plus one retry: the default client retries forever, which in
  // a diagnostic means hanging instead of reporting that Redis is down.
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: PROBE_TIMEOUT_MS,
  });

  // ioredis emits `error` on a refused connection whether or not the promise
  // also rejects, and an unhandled one prints a stack above the report. The
  // rejection below is what this function reads.
  redis.on('error', () => {});

  try {
    await redis.connect();
    await redis.ping();
    return interpretRedis({ reachable: true });
  } catch (err) {
    return interpretRedis({
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    redis.disconnect();
  }
}

/**
 * The cheapest authenticated call each provider offers.
 *
 * A models list rather than a completion: it costs nothing, needs no model name
 * to be valid, and still exercises the credential — including the billing state
 * behind it, which is the failure worth catching.
 */
function aiProbeFor(
  provider: string,
  keys: Record<string, string | undefined>,
): Promise<Probe> | null {
  const key = keys[provider];
  if (!key) return null;

  switch (provider) {
    case 'openai':
      return probe('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
    case 'anthropic':
      return probe('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
    case 'gemini':
      return probe(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      );
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const graph = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}`;
  const auth = { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` };

  // A fresh challenge each run. A fixed one could be echoed by a cache and read
  // as a working endpoint.
  const challenge = randomUUID();
  const handshakeUrl = new URL(whatsappWebhookUrlFor(env.API_BASE_URL));
  handshakeUrl.searchParams.set('hub.mode', 'subscribe');
  handshakeUrl.searchParams.set('hub.verify_token', env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  handshakeUrl.searchParams.set('hub.challenge', challenge);

  const aiKeys: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
  };

  // Everything at once. These are independent, and a serial run spends its time
  // waiting on timeouts for whichever service is down.
  const [database, redis, phoneNumber, subscribedApps, handshake, aiKey] = await Promise.all([
    checkDatabase(env.DATABASE_URL),
    checkRedis(env.REDIS_URL),
    probe(
      `${graph}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: auth },
    ),
    env.WHATSAPP_BUSINESS_ACCOUNT_ID
      ? probe(`${graph}/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`, { headers: auth })
      : Promise.resolve(null),
    probe(handshakeUrl.toString()),
    aiProbeFor(env.AI_PRIMARY_PROVIDER, aiKeys) ?? Promise.resolve(null),
  ]);

  const whatsapp: CheckResult[] = [
    interpretPhoneNumber(phoneNumber),
    interpretWebhookHandshake(handshake, challenge),
  ];

  if (subscribedApps) {
    whatsapp.splice(1, 0, interpretSubscribedApps(subscribedApps));
  } else {
    whatsapp.splice(1, 0, {
      name: 'Webhook subscription',
      level: 'warn',
      detail: 'not checked — WHATSAPP_BUSINESS_ACCOUNT_ID is not set',
      fix: 'Set it to check automatically that Meta will deliver webhooks. It is on the same API Setup tab as the phone number id.',
    });
  }

  const sections: ReportSection[] = [
    { title: 'Local services', results: [...database, redis] },
    { title: 'WhatsApp', results: whatsapp },
    {
      title: 'Mail',
      results: [
        interpretGoogleOAuth({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          redirectUri: env.GOOGLE_REDIRECT_URI,
          apiBaseUrl: env.API_BASE_URL,
        }),
        interpretGmailDelivery({
          pubsubTopic: env.GOOGLE_PUBSUB_TOPIC,
          pollIntervalMs: POLL_INTERVAL_MS,
        }),
        outboundIsLive(env.NODE_ENV),
      ],
    },
    {
      title: 'AI',
      // `interpretAiConfig` returns null unless AI is switched off entirely,
      // and the probe is absent for the same reason — exactly one of the two
      // has something to say.
      results: [
        interpretAiConfig(env.AI_PRIMARY_PROVIDER),
        aiKey ? interpretAiKey(aiKey, env.AI_PRIMARY_PROVIDER) : null,
      ].filter((r): r is CheckResult => r !== null),
    },
  ];

  process.stdout.write(renderReport(sections));
  process.exitCode = exitCodeFor(worstLevel(sections.flatMap((s) => s.results)));
}

main().catch((err) => {
  // `loadEnv` throwing is the expected path here: a variable is missing, and
  // its own message names every one of them. Anything else is a bug in the
  // checker, and printing it beats a stack trace nobody reads.
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exitCode = 1;
});
