# Development setup

## Prerequisites

- Node 22 (`.nvmrc` pins it — `nvm use`)
- pnpm 10 (`corepack enable && corepack prepare pnpm@10 --activate`)
- Docker with Compose v2

## First run

```bash
cd whatsapp-email-assistant

pnpm install
cp .env.example .env

# Generate the secrets the boot check requires
printf 'ENCRYPTION_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" >> .env
printf 'BLIND_INDEX_KEY=%s\n'       "$(openssl rand -base64 32)" >> .env
printf 'JWT_ACCESS_SECRET=%s\n'     "$(openssl rand -base64 64)" >> .env
printf 'JWT_REFRESH_SECRET=%s\n'    "$(openssl rand -base64 64)" >> .env

pnpm infra:up        # postgres + redis + minio + mailpit
pnpm db:migrate      # from Phase 3
pnpm db:test-role    # lets the integration suite connect as the restricted role
pnpm dev             # all apps in watch mode
```

`db:test-role` is the step it is easy not to know about. The hardening migration
creates the application role `wea_app` as `NOLOGIN` — correct for production, where
the app authenticates with a managed credential rather than a password in version
control — but the integration suite has to _connect_ as that role, because
Postgres exempts the table owner from row-level security and every isolation
assertion in the project passes vacuously against the owner. Without this step
`TEST_DATABASE_URL` cannot connect and 283 tests skip themselves silently.

The process refuses to start on a missing or malformed variable, and prints every
offending one at once. That is deliberate — see `packages/shared/src/config/env.schema.ts`.

### Local services

| Service  | Address                | Notes                                          |
| -------- | ---------------------- | ---------------------------------------------- |
| API      | http://localhost:3001  | REST, GraphQL, webhooks                        |
| Web      | http://localhost:3000  | Dashboard                                      |
| Postgres | localhost:5432         | user `wea`, db `wea`                           |
| Redis    | localhost:6379         | db 0 cache, db 1 queues                        |
| MinIO    | http://localhost:9001  | `minioadmin` / `minioadmin`                    |
| Mailpit  | http://localhost:8025  | Catches all outbound dev mail                  |
| Jaeger   | http://localhost:16686 | `docker compose --profile observability up -d` |

**No real email leaves a development machine.** Outbound send is pointed at Mailpit
unless `NODE_ENV=production`.

## Third-party credentials

Local development works without them for everything except the integration each
one powers. Fill in only what you need.

### WhatsApp Business Cloud API

1. Create a Meta app, add the WhatsApp product, note the test phone number id.
2. Set `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`.
3. Expose your local API (`cloudflared tunnel --url http://localhost:3001`) and register
   `https://<tunnel>/webhooks/whatsapp` with the verify token you set in
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.

`WHATSAPP_APP_SECRET` is not optional even locally — the webhook rejects any request
whose `X-Hub-Signature-256` does not verify, in every environment.

### Google / Gmail

1. GCP project → enable Gmail API and Pub/Sub.
2. OAuth client (Web) with redirect `http://localhost:3001/v1/oauth/google/callback`.
3. Pub/Sub topic + push subscription pointed at `https://<tunnel>/webhooks/gmail`, and
   grant `gmail-api-push@system.gserviceaccount.com` the Publisher role on the topic.

### Microsoft / Outlook

1. Entra ID app registration, redirect `http://localhost:3001/v1/oauth/microsoft/callback`.
2. Delegated permissions: `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read`.
3. `MICROSOFT_WEBHOOK_CLIENT_STATE` — any random string; Graph echoes it back and we
   compare it in constant time.

## Common commands

```bash
pnpm dev                 # every app, watch mode
pnpm build               # build everything (turbo, cached)
pnpm test                # all tests; the database-backed ones skip without TEST_DATABASE_URL
pnpm test:integration    # needs pnpm infra:up and pnpm db:test-role
pnpm lint                # eslint
pnpm typecheck           # tsc --noEmit everywhere
pnpm format              # prettier --write

pnpm --filter @wea/shared test          # one package
pnpm --filter @wea/api dev              # one app

pnpm db:migrate          # create + apply a migration
pnpm db:studio           # Prisma Studio
pnpm infra:reset         # wipe volumes and start clean
```

### The dashboard

```bash
pnpm --filter @wea/web dev     # http://localhost:3000, expects the API on :3001
```

Two things about it are worth knowing before you debug it.

The **Content-Security-Policy** is issued per request by `apps/web/src/middleware.ts` with a
fresh nonce, and it only works because the root layout sets `export const dynamic =
'force-dynamic'`. Remove that and every route is prerendered at build time, before any nonce
exists — Next then emits unnonced `<script>` tags that its own policy blocks, and the page is
blank. Development never prerenders, so this is invisible until you run `next build && next
start`. If you are changing rendering behaviour, check a production build, not `pnpm dev`.

The dashboard talks to a **different origin** than it is served from, so `connect-src` names
it explicitly from `NEXT_PUBLIC_API_BASE_URL`. If requests are failing with nothing in the
network tab but a CSP violation in the console, that variable is wrong — and because Next
inlines `NEXT_PUBLIC_*` at build time, changing it needs a rebuild rather than a restart.

## Conventions

- **Package boundaries are real.** `apps/*` may depend on `packages/*`; packages may
  depend on `@wea/shared` and each other, but never on an app. A module never reaches
  into another module's repositories (ADR 0001).
- **Nothing sensitive is logged.** Every value passed to the logger goes through
  `redact()` from `@wea/shared`. Adding a `console.log` of a request body will fail
  review, and `no-console` fails the build.
- **Secrets never enter a test fixture.** Tests generate their own keys.
- **Every model output is schema-validated** before use (ADR 0004).
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.

## Troubleshooting

**`Invalid environment configuration`** — the listed variables are missing or malformed.
Values are never echoed, so check `.env.example` for the expected shape.

**Postgres extension errors on migrate** — the `pgvector/pgvector:pg16` image plus
`infra/docker/postgres/init/01-extensions.sql` create `vector`, `pg_trgm` and `pgcrypto`
on first boot only. If the volume predates that file, run `pnpm infra:reset`.

**Webhook returns 401 locally** — signature verification is on in all environments.
Confirm `WHATSAPP_APP_SECRET` matches the app secret in the Meta dashboard, not the
access token.
