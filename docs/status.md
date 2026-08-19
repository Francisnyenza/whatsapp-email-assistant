# Build status

Honest accounting of what exists, what is verified, and what remains.

Last updated: 2026-08-15.

---

## The application could not start

Worth putting before anything else, because it undercuts how the rest of this
document should be read.

Until now, **neither service could boot**. `ConfigService` — the class every other
class depends on — declared
`constructor(source: NodeJS.ProcessEnv = process.env)`. `emitDecoratorMetadata`
records that parameter's type as `Object`; a default value is not part of the
metadata, and dependency injection always supplies its own argument. So Nest looked
for a provider of type `Object`, found none, and refused to construct it. Everything
downstream failed with `Cannot read properties of undefined (reading 'env')`.

It survived because of a second bug that hid it. Nest handles a start-up failure
inside its own exception zone and calls `process.exit(1)` from there — before
`bootstrap().catch` runs — and both `main.ts` files passed `logger: false`, which
suppressed the only place the reason was printed. The observable behaviour was a
process that exited 1 having written **nothing at all**, to stdout, stderr or a file.

Four more sat behind it, each only reachable once the one in front was fixed:

|                 | Was                                                                                                                                                                                                       | Now                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pino-pretty`   | Referenced by the logger, a dependency of nothing. In `NODE_ENV=development` — the default — both services died at boot.                                                                                  | Declared, and the transport is skipped rather than fatal when it cannot be resolved. Colour is not worth a process that will not start.          |
| `pnpm dev`      | `tsx`, which transpiles with esbuild — and esbuild does not implement `emitDecoratorMetadata`. Every injected parameter was `undefined`, so the command the docs tell you to run could never have worked. | `node --watch --import @swc-node/register/esm-register`, which emits the metadata.                                                               |
| `/health/ready` | Hung indefinitely when Redis was unreachable, and answered **200 with `status: "degraded"`** when it did answer — so Kubernetes kept routing traffic to a pod that had just declared itself broken.       | Both checks bounded at 3s and run concurrently; 503 when degraded. The worker's health listener had always done this, and said why in a comment. |
| `pnpm doctor`   | The name of pnpm's own built-in command, which shadowed the script: it ran pnpm's checker, printed nothing useful, and exited 0.                                                                          | Renamed to `pnpm preflight`.                                                                                                                     |

One more thing was green throughout and should not have been. CI had a step
named **“Check the image starts”** which overrode the entrypoint and imported a
single package — it never started anything, and passed on every run while the
image it was checking could not boot. It now runs the real entrypoint against a
real Postgres and Redis and waits for the process to answer `/health/live`.

Chasing the same thread into the container found two more.

**The images could not run either.** `apps/api` and `apps/worker` declared no
`files` field, so `pnpm deploy --prod` fell back to npm-pack semantics, which
honour `.gitignore` — and `.gitignore` has `dist/`. The deployed tree contained
`src`, `test` and `vitest.config.ts` but **not the build**, so the entrypoint died
on `Cannot find module '/app/dist/main.js'`. Every `packages/*` already declared
`"files": ["dist"]`; the two apps never did. Both now do, and the deployed tree is
`dist`, `node_modules`, `package.json` — which is what the Dockerfile's own comment
about shipping no compiler and no test files always claimed it was.

**`KMS_PROVIDER` was read by nothing.** This is the one with a security
consequence rather than a crash. ADR 0002 says the key-encryption key lives in a
managed KMS and that the local key merely "stands in for KMS behind the same
interface". The interface exists. Nothing behind it does — there is no AWS, Azure
or GCP provider — and all four call sites (three in the API, one in the worker)
constructed `LocalKmsProvider` directly whatever the setting said. Two outcomes,
and the quiet one is worse:

- With `KMS_PROVIDER=aws` and no master key — the only shape the schema permits in
  production — every one of those constructors threw at boot. Production was
  unreachable by construction.
- With `KMS_PROVIDER=aws` **and** a master key, which is what copying
  `.env.example` gives you, it started and used the static key from its own
  process environment while the operator believed the KEK was in a managed
  service.

Selection now goes through a single `createKmsProvider`, and a provider that is
not implemented is a **refusal**, not a fallback — a fallback here is the same bug
with a friendlier face, and the test that pins it is the one asserting a throw in
the case where falling back would have worked. `LocalKmsProvider`'s own comment
claimed the schema made it unreachable in production; that was true of the name
and not of the code, and it has been corrected.

**This means there is still no production configuration that boots.** That is not
a regression — it was always so — but it is now loud instead of silent, and it is
the top item under _Next, in order_. The CI image smoke test runs `staging` for
this reason, and says so.

**How this got past 1 900 tests.** Unit tests build services with `new Service(deps)`
and never ask the container to do it. `di.spec.ts` counts constructor parameters
through reflection, which is a different question from whether they resolve. Nothing
anywhere started an application. So `apps/api/test/boot.spec.ts` and
`apps/worker/test/boot.integration.spec.ts` now do exactly that, and each was
confirmed to fail when the fix is reverted. CI gained a Redis service so the worker's
can run there — `createApplicationContext` runs lifecycle hooks, so its consumers
really do attach.

The API and the worker have both since been started, serving `/health/live`,
`/health/ready` and `/metrics`, with the worker registering its schedulers and running
its sweeps against a real database.

## Verified working

Everything below has tests that run and pass. **1 940 tests** (1 565 unit + 375 integration
against real Postgres), lint and typecheck clean across every package and app.

| Package         | Tests            | What it does                                                                                                                                         |
| --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wea/shared`   | 105              | Env contract, domain types, queue definitions, log redaction, action-payload codec, phone normalization, preflight checks                            |
| `@wea/crypto`   | 113              | Envelope encryption (AES-256-GCM + KMS), Argon2id, TOTP (RFC 6238), token hashing, signatures, blind indexes                                         |
| `@wea/db`       | 9 (integration)  | Prisma schema, thirteen migrations, seed. RLS verified against real Postgres 16 + pgvector — including a sweep over every table carrying a `user_id` |
| `@wea/whatsapp` | 219              | Session window, delivery policy, webhook parsing, builders, templates, Cloud API client, command parser                                              |
| `@wea/mail`     | 235              | Threading, forwarding, MIME, recipient validation, Gmail + Microsoft Graph adapters, OAuth, error classification                                     |
| `@wea/ai`       | 218              | Injection envelope, instruction detection, analysis, embeddings, translation, drafting, speech, question answering, OpenAI + Gemini + Anthropic      |
| `apps/api`      | 198 + 52 (int.)  | Auth, 2FA, phone verification, mailbox list/disconnect, preferences, webhooks, OAuth connect, health, metrics                                        |
| `apps/worker`   | 439 + 314 (int.) | Ingest, analysis, embeddings, search, summarise, translate, read aloud, ask, draft, deadlines, notify, planner, actions, sweeps, health, metrics     |
| `apps/web`      | 38               | API client (token handling, refresh), Content-Security-Policy, sign-in, mailboxes, phone, settings                                                   |

```bash
pnpm -r test          # 1 565 unit tests
pnpm --filter @wea/db test:integration   # needs TEST_DATABASE_URL on the wea_app role
```

### Verified against real infrastructure

- All eleven migrations apply to PostgreSQL 16 with pgvector; the seed is idempotent.
- Row-level security isolates tenants: no context → no rows; scoped → own rows only;
  cross-tenant read → empty; cross-tenant write → refused by policy.
- The watch-renewal sweep reads every tenant's routes without gaining read access to any
  tenant's mailbox — asserted directly, as `wea_app`, in `watch-renewal.integration.spec.ts`.
- `audit_logs` rejects UPDATE and DELETE at both the grant and trigger level.
- Encryption-pairing CHECK constraints reject ciphertext stored without its wrapped key.
- HNSW, trigram and partial indexes are created.
- A WhatsApp command reaches the mailbox: "archive" flips `is_archived` and the provider is
  asked to archive; a tapped delete confirmation sets `deleted_at` and asks for the trash,
  never a permanent delete; "yes" writes a real draft with `Re: ` and the parent's
  `Message-ID`, encrypted, and queues one send keyed on the draft.
- When the provider refuses, the user is told so — the reply never claims an action that
  did not happen.
- A forward asks first, remembers the recipient server-side, and on confirmation writes a
  `Fwd: ` draft with no threading headers, the original quoted, and its attachments carried.
  A second tap on the same confirmation sends nothing.
- Message bodies are stored encrypted and read back; ciphertext is bound to both the user
  and the `messageBody` field, so another tenant's key and the draft-body field each fail
  to open it. Ingest still delivers the email when sealing fails.
- The retention sweep erases bodies past `RETENTION_BODY_DAYS` across every user, records
  `body_purged_at`, is idempotent, and — asserted as `wea_app` — still cannot read or erase
  a body belonging to anyone but the tenant it is scoped to.
- TOTP matches the RFC 6238 published vectors, so it interoperates with real authenticator
  apps rather than only with itself.
- Two-factor enrolment stores a secret without enabling anything, and enables only once a
  working code is produced; a replayed code is refused; recovery codes work once each and
  are not spent by a mistyped TOTP; the factor survives a refresh rotation but does not
  leak to a session that never verified.
- Mail arriving outside the 24-hour window is delivered as an approved template rather than
  a free-form message Meta would silently drop; ordinary mail defers instead of paying for
  one; and the window exception refuses to carry anything that is not a template.
- Untrusted email content reaches the model inside a nonce-delimited envelope it cannot
  close, with the reminder placed after the data; text aimed at an assistant is detected
  deterministically and raises a warning the model's own answer cannot lower.
- Model output is schema-validated and discarded on failure, never coerced — a partial
  analysis produces nothing rather than a half-trusted object.
- Analysis never costs an email its delivery: no provider, no budget, invalid output,
  provider down, unreadable body — every exit still queues the notification.
- Ingest resumes from the cursor we stored rather than the one on the job, and advances only
  to the position the provider reported — asserted directly, because both halves were wrong
  and the push path found no mail at all.
- A mailbox with no push subscription is polled every two minutes and stops being polled the
  moment a watch is established — asserted across tenants, and in both directions as a watch
  is gained and lost.
- Every email is embedded after it is notified, never before: search is built on the back of
  delivery rather than in front of it, and a queue failure on the embedding cannot delay a
  card or re-send one.
- Search is hybrid and degrades rather than fails. A query is answered by cosine distance
  over pgvector, `tsquery` over subject and snippet, and trigram similarity over subject and
  sender, fused by reciprocal rank — and with no model provider configured the semantic arm
  simply contributes nothing while the other two still find the mail. Asserted against real
  rows: an exact subject word, a word from the snippet, a misspelled sender name, an address
  fragment, and a message only the vector can reach.
- Search and the standing lists never cross a tenant boundary on either arm, asserted as
  `wea_app`, including a write attempt against another user's message.
- All three model providers named in the environment are implemented, and a name with no
  implementation refuses to start rather than disabling summaries quietly. Gemini asks for
  the embedding dimension the column declares, joins a multi-part response, and treats a
  safety block — which arrives as a 200 with no text — as invalid output. Anthropic gets JSON
  out of an API with no JSON mode by prefilling the assistant turn, and puts the brace back.
- A deployment can say it wants no AI at all, and one that does still delivers mail, still
  searches on keywords, and says so once at boot rather than per email.
- A newly connected mailbox's _history_ becomes searchable, not only its future. The backfill
  sweep pages over users owed one, queues the same `ai.embedEmail` job ingest does with the
  same id, skips a user whose token allowance is spent before doing any work for them, and
  records a mailbox as done so it is never asked again. Bounded by `EMBEDDING_BACKFILL_DAYS`
  at one end and the per-user token budget at the other; `0` turns it off.
- Deferred mail is recorded, and delivered as a digest the moment the user next messages us
  — or on their own scheduled times, in their own timezone. A suppressed message is never
  resurfaced; an archived one is not offered; and the backlog is cleared only for what was
  actually shown, so the out-of-window template does not lose the mail it announced.
- The Terraform module is checked against the real AWS provider schema in CI — `validate`
  after `init`, so every resource type, attribute name and variable reference is verified
  rather than eyeballed. This is the one thing in the project that **could not** be verified
  in the environment it was written in: that proxy blocks `registry.terraform.io`, so `init`
  fails and there are no schemas to check against. Formatting was all that could be
  confirmed locally, which is exactly why the CI job exists.
- The worker exports `wea_queue_depth` on `/metrics` — the one thing about this system's
  health Kubernetes cannot see, since everything kube-state-metrics reports is about pods
  and a backlog is about work. Served from the health listener rather than a second port:
  same trust boundary, one less thing to secure. A scrape that cannot reach Redis answers
  **503, not an empty 200**, because an empty scrape reads as "every queue is empty" — the
  exact reading that would suppress a backlog alert during the outage causing the backlog.
  A non-finite sample is dropped rather than emitted, since one unparseable line fails the
  whole endpoint in Prometheus and takes every healthy series with it.
- The API exports `wea_http_requests_total` and `wea_http_request_duration_seconds` on
  `/metrics`, which is what makes an error rate and a p95 expressible at all — before it,
  the only thing the alerts could see about the API was whether any replica was running,
  so an API returning 500 to every Meta webhook read as healthy. Three decisions in it are
  load-bearing and each is pinned by a test:
  - **Route templates, never paths.** `/accounts/:id` is one series however many accounts
    exist. Recording the URL would mint a series per account, forever, and a metrics
    endpoint is a normal way to take down the Prometheus that scrapes it. Every path that
    matched no route shares one `unmatched` label, so a scanner sweeping ten thousand URLs
    creates one series rather than ten thousand; the method token, which is arbitrary text
    off the request line, is folded the same way. Past a hard cap of 500 series the labels
    are folded rather than the sample dropped — dropping would understate traffic during
    exactly the incident that blew cardinality up.
  - **A middleware, not a Nest interceptor.** An interceptor runs inside a matched handler
    and never sees a 404, which would make the cheapest way to probe an API the one thing
    the error-rate metric could not show. It is mounted first in `bootstrap`, ahead of the
    body parser, so a request rejected for malformed JSON is measured too.
  - **An abandoned request is a 499, not a 200.** Timing ends on the response's `close`
    rather than its `finish`, so a request the client gave up on is recorded at all; and
    since nothing overwrote `res.statusCode`, reporting it verbatim would file the requests
    users abandoned as the successful ones — which are precisely the ones a latency alert
    exists to find.

  Served from the main port alongside `/health/live` and `/health/ready`: the same trust
  boundary those two already sit behind, and one less listener to secure. That does mean
  **an Ingress must not route `/metrics`** — route names and traffic volumes are cheap
  reconnaissance. The scrape itself is excluded from its own counters, because at fifteen
  seconds per replica it would be most of the traffic on a quiet API and the request-rate
  panel would be the monitoring system watching itself.

- `pnpm preflight` checks every external seam and says what to change. The environment
  schema already refuses to boot on a variable that is missing or malformed; what it
  cannot see is one that is well-formed and wrong, and every such failure in this product
  is silent — the system starts, passes both health checks, and never delivers a message.
  The checks that earn their place are the ones nothing else can answer:
  - **Meta's webhook handshake, performed against our own endpoint.** The only thing that
    proves the tunnel resolves, the request reaches this codebase, and the verify token the
    _running process_ holds matches the one in the file just edited. A 403 to our own token
    means a stale process; a 200 that does not echo the challenge means the tunnel is
    pointed at the dashboard on :3000 rather than the API on :3001.
  - **`subscribed_apps` on the WhatsApp Business Account.** Registering a callback URL
    makes verification pass and delivers nothing — the app must also be subscribed. Every
    screen reads as configured and no message ever arrives.
  - **The Google redirect URI, compared against the one the API actually serves.**
    `redirect_uri_mismatch` is the first error every Google integration hits, and Google's
    message names the URI it received without naming the one it expected. This derives the
    correct value and prints it ready to paste.
  - **The AI key, tried rather than inspected.** A present, well-shaped key can still
    belong to an account with no credit; the provider then answers 429 to every request,
    the worker retries each as transient, and the user gets an inbox with no summaries and
    no explanation.

  The interpreters are pure over a reduced probe shape and live in `@wea/shared`, so the
  remediation text — which is the actual product here — is asserted by 49 tests without a
  network. A 403 carrying no Meta error envelope is reported as a proxy answering in
  Graph's place rather than as a permission error, which was found by hitting exactly that
  against an egress allowlist. Read-only throughout, and non-zero only on a real failure so
  it can gate a deploy: polling instead of push and AI switched off are supported
  configurations, not faults.

- **Outbound mail is live in every environment, and this file used to imply otherwise.**
  `docs/development.md` claimed development sends were captured by Mailpit; nothing in the
  send path did that — Gmail and Graph are called with the user's own OAuth token whatever
  `NODE_ENV` says, and there is no SMTP hop to intercept. The Mailpit service has been
  removed from `docker-compose.yml` rather than left as a sandbox that was not one, and
  `pnpm preflight` states the position on every run.
- The alert rules are validated twice, because the two tools answer different questions.
  kubeconform checks the `PrometheusRule` is shaped correctly; the PromQL inside it is just
  a string to a schema, and a malformed expression is accepted by the cluster and then
  silently never evaluates — so `promtool check rules` parses every expression as well.
  Both were confirmed to be load-bearing by breaking a rule on purpose and watching each
  exit non-zero. Neither can check that the metric _names_ exist. Most rules are therefore
  written against kube-state-metrics, whose names are standard and need no instrumentation
  here to keep in step; the `wea.queues` and `wea.api` groups are the exception, and each
  metric name they use is asserted as a literal string by the exporter's own tests.
- The worker scales on queue depth rather than CPU, via a KEDA `ScaledObject` validated in
  CI against the published CRD schema. Triggers cover only the three queues a person is
  waiting on — `commands`, `notify`, `send`. `ingest`, `ai` and `sync` are deliberately
  excluded: a backlog there means mail is summarised a few minutes later, which nobody
  perceives, while including them would let an embedding backfill of ten thousand old emails
  scale the deployment to its ceiling for work nobody is waiting on. It never scales to
  zero, because activation is a cold start and the promise is five seconds. The file lives
  apart from the rest, because applying `infra/k8s/` must not require KEDA to be installed.
- The worker answers `/health/live` and `/health/ready`, so its Deployment has real probes.
  Readiness checks Postgres and Redis and answers **503**, not a 200 carrying the word
  "degraded" — a probe reads the status code and nothing else, so the second would be a
  worker that reports itself broken and keeps being sent work. Liveness checks neither, so a
  Redis blip cannot restart every worker at the moment the backlog most needs consumers.
  Both dependencies are checked even when the first fails, so an outage names the right
  system. Tested against a real socket, including that the listener is exactly two routes,
  refuses non-GET, and reflects nothing back from the request path.
- The Kubernetes manifests validate against the real 1.30 schemas in CI (kubeconform,
  `-strict`), not by eye. A misspelled field is accepted silently by `kubectl apply` — the
  object is created and the setting simply does not exist — so a typo in
  `terminationGracePeriodSeconds` would give a worker killed mid-job and a manifest that
  reads as though it is not.
- The production images build and run. One Dockerfile serves both Node services, staged so
  the runtime carries no compiler, no tests and no dev dependencies. Docker was not
  available in the environment they were written in, so CI builds both and then _runs_ one,
  importing `@wea/db` inside the container — an image that builds and cannot require its own
  dependencies is the specific failure a staged build invites, and only running it catches
  that. Both jobs green on the first attempt, which means the two details that usually bite
  held: Prisma's generated client survives the pruning production install, and the slim base
  has the OpenSSL its query engine needs.
- The CI pipeline runs the exact sequence a fresh clone needs, and it was verified by doing
  that here rather than by reading it: a brand-new database, the extension script, every
  migration, the restricted-role grant, then all 283 database-backed tests. Lint, typecheck,
  build, formatting and the unit suites run in a second job with no database at all, which
  is also a test — it proves the DB-backed suites still skip cleanly for a developer who has
  not set `TEST_DATABASE_URL`.
- A free-form question is answered from the user's own mail and nothing else. The candidate
  set comes from the same hybrid search `search` uses, so it is scoped by row-level
  security — asserted against real rows. Each retrieved email reaches the model inside its
  own nonce-delimited block, numbered rather than identified: **no real email id is ever put
  in front of the model**, so a citation it invents refers to nothing and the rows the user
  taps are server-minted by construction rather than by check. Output is schema-validated
  and discarded on failure. An answer claiming to have deleted or forwarded mail changes
  nothing, because there is no path from this call to a mutation — asserted by making a
  stub model say exactly that.
- Retrieval for a question is deliberately narrower than for a search (four sources, not
  ten): every source is third-party prose competing with the system prompt, so each one
  added makes an injection marginally more likely to land.
- "Read it aloud" comes back as a voice note. The email is announced by sender and subject
  before a word of it is read, quoted history and signatures are cut, and it is bounded to
  about two minutes — with the recording itself saying it stopped early, because a caption
  would not be shown on an audio message. The audio is Ogg-Opus, which is the only thing
  WhatsApp renders as a voice note rather than as a file. A provider that cannot speak says
  so as a different sentence from a deployment with no provider at all, and neither is
  retried. An upload that fails produces a sentence, never a media message with no id.
- A compose asks before it sends, like a delete and a forward do. It is the most
  irreversible verb in the product — every other one acts on a message already in the
  mailbox, so a mistake has a thread behind it to catch it, while a compose has a typed
  address and nothing else. The planner had built that confirmation from the first day and
  the processor sent the email anyway, discarding it: a payload written, never shown, and no
  test noticed because every test asserted the draft. It surfaced only when Bcc was added
  and the sender could not see the one field nobody else will ever see. The addresses and
  the words are written to the pending slot server-side; the button carries a fixed
  sentinel, so a crafted id can re-authorise this email and cannot redirect it.
- A file sent **into** the chat is held rather than acted on, and the next email carries it.
  Holding is not a convenience: a chat has no draft window to keep open, and asking "who is
  this for?" before accepting the file would lose it the moment the user answered with a new
  thought instead. What is stored is Meta's media id, never the bytes — Meta serves inbound
  media for 30 days, so a file the user staged and never sent is one that was never held.
  The claim happens inside the transaction that creates the draft, so a draft cannot exist
  without its files and files cannot be spent on a draft that failed to appear. The size
  comes from Meta's media metadata at staging time, because the webhook carries none and a
  budget checked at send time is a budget checked after the user has been told the email is
  going.
- The dashboard's Content-Security-Policy was checked against a real production build, not
  only against the middleware's return value: served from `next start`, every one of the ten
  `<script>` tags carries the nonce from that request's own header, and the nonce differs per
  request. The same build without `export const dynamic = 'force-dynamic'` emitted twelve
  script tags and nonced none of them — see the finding below.

---

## Mail-app parity: what a WhatsApp chat can and cannot do

Audited against the verb list of an ordinary mail client, because "manage your email
entirely from WhatsApp" is the product claim and this is the honest scoreboard for it.

| Capability                         | In a chat? | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receive mail                       | ✅         | Push from Gmail and Graph, polling fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Reply                              | ✅         | Threaded, from the user's own address                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Reply with AI drafting             | ✅         | Composed, shown, confirmed by tap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Forward                            | ✅         | Carries the original's attachments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Archive                            | ✅         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Delete                             | ✅         | Confirmation tap; trash, never permanent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Mark read / unread                 | ✅         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Star / important                   | ✅         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Search                             | ✅         | Hybrid: vector + full-text + trigram                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Standing lists                     | ✅         | today, unread, urgent, deadlines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Summarise / translate / read aloud | ✅         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Free-form questions                | ✅         | RAG over the user's own mail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Compose a new email**            | ✅         | `email alice@acme.com about Q3 saying …`. Recipient validated by `parseRecipientList`, which refuses rather than repairs; no threading headers, so it cannot graft onto an unrelated conversation; sends from the primary mailbox. Multi-turn prompting for a missing body is not built — it asks and the user retypes.                                                                                                                                                                                                                                                                                                                                        |
| **Attachments — into the chat**    | ✅         | `send me the attachment`. `QUEUE.MEDIA` now has both a producer and a consumer. One job per file, keyed on the attachment so asking twice does not send twice. Capped at 25 MB, measured while reading rather than trusting `sizeBytes`. Refuses a flagged file, and an inline signature logo, each with a sentence.                                                                                                                                                                                                                                                                                                                                           |
| **Attachments — out of the chat**  | ✅         | A photo or document sent into the chat is _held_ — there is no draft window to keep open — and the next email carries it. The bytes stay on Meta's servers until send time, so a file staged and never sent is one that was never stored. Sized against the same 20 MB ceiling a forward is, at staging time rather than after "sending…". `drop the files` forgets them; they expire after a day. **Dictation is still not built: a voice note is ignored rather than attached as an `.ogg`.**                                                                                                                                                                |
| **Voice note → email**             | ✅         | A voice note is transcribed and the words are handled exactly as if typed, with the transcript echoed in the same exchange — a mis-transcription has to be visible alongside what it caused. `JOB.TRANSCRIBE_AUDIO` had been in the shared constants since Phase 2 with no producer and no consumer. OpenAI only: Anthropic publishes no transcription API and Gemini's is a multimodal completion rather than an audio endpoint, so both say so up front rather than failing on the call. A deployment with no provider says so too. Ordinary audio files are still attached rather than listened to — Meta marks the difference with `voice: true`.          |
| **CC / reply-all / Bcc**           | ✅         | `reply all saying …`, `email alice@x.com cc bob@x.com bcc carol@x.com saying …`. Both copy lists are parsed from one segment in either order and validated by the same `parseRecipientList` as the To. The Bcc is shown on the confirmation — to the one person it is not hidden from, who is the only one able to catch a mistake in it, because nobody on the message can see that it went astray.                                                                                                                                                                                                                                                           |
| **Subject editing**                | ✅         | A compose chooses its own (`email alice@acme.com about Q3 saying …`), and a reply can rename the conversation (`reply about Q4 planning saying …`), which is what a mail client offers when a thread drifts onto a new topic. It does not detach the reply from its thread — `In-Reply-To` and `References` do that work and every client groups by those, which the integration test pins. A forward's subject is still derived (`Fwd: `).                                                                                                                                                                                                                    |
| **Folders / labels**               | ✅         | Labels: `label this as Receipts`, `remove the Receipts label`, `what labels do I have`. Moves: `move this to Projects`, `what folders do I have`. The two providers mean different things by a move and the port absorbs it — Outlook's folders are exclusive, and Gmail has none, so a move there is a label plus leaving the inbox, exactly as Gmail's own "Move to" does. Adding an unknown _label_ creates it; moving to an unknown _folder_ refuses, because a move takes the message out of the inbox and a typo would put it somewhere the user cannot find. Trash and Junk are never offered as destinations: each has its own verb, which asks first. |
| **Snooze**                         | ✅         | `snooze until tomorrow`, `snooze for 2 hours`, `remind me about this on Monday`. The `reminders` table has existed since the first migration, with an index whose comment reads "drives the due-reminder sweep" — and there was no sweep, no producer and no repository. The time resolves in the user's own timezone and is said back as a date and a clock time, because "until Monday" is not something a misreading is visible in. A snooze is forgotten when the user replies, archives or deletes the message first.                                                                                                                                     |
| **Spam / not spam**                | ✅         | `this is spam`, `not spam`. Both adapters had implemented the move since Phase 7 — Gmail by label, Graph by folder — and nothing in a chat could ask for it. The rescue is matched before the filing, because "not spam" contains "spam" and the wrong order files a rescued message straight back into junk.                                                                                                                                                                                                                                                                                                                                                  |
| **Undo**                           | ✅         | `undo` takes back the last archive, delete, star, read, spam filing, label, move or snooze, for ten minutes — and **an email that has not left yet**. Every outgoing message waits 15 seconds in the queue before the worker may claim it, which is the only honest way to offer an unsend: once a message reaches the provider it is with the recipient, and no API takes it back. Past the window it says the mail has gone rather than claiming an undo it did not perform. One slot, not a stack, and the record is spent on read — the inverse of the inverse is the original action.                                                                     |
| **Multi-account send selection**   | ✅         | `email alice@acme.com from work saying …`, `which mailboxes do I have`. Matches a nickname, an address, or the domain — which is how people refer to a mailbox they never named. The confirmation now names the sending address in every case, because with two connected the user cannot otherwise tell which identity is about to speak for them. A hint matching nothing refuses and names the options; one matching two also refuses, since choosing would be a coin flip on the user's identity.                                                                                                                                                          |
| **Contacts**                       | ✅         | `email sarah saying …`. The address book is built from mail that actually arrived — no contacts scope, and a record of correspondence rather than of acquaintance, which is what "email sarah" means. `contacts.aliases` had been _read_ by the thread resolver since it was written and nothing ever wrote a row, so that rank matched an empty table for every real user. Resolution refuses rather than guesses: one match resolves, two list both, none says so. An address the user typed is passed through untouched.                                                                                                                                    |

---

## Not yet built

Listed plainly, because a half-wired OAuth flow is worse than an absent one.

### Next, in order

Reordered against the parity audit above. The deployment work is real but it ships a
product that cannot compose an email, and that ordering was wrong.

Also open, and found by the RLS sweep added with the attachment work: `subscriptions`,
`org_memberships` and `audit_logs` carry a `user_id` and have no tenant policy.
`provider_account_routes` legitimately has none — the webhook endpoints read it _to
discover_ which tenant a delivery belongs to — but the other three are a gap rather than a
design, and are pinned by an equality assertion in `tenant-isolation.integration.spec.ts`
so the list cannot quietly grow.

1. **A managed KMS provider.** `createKmsProvider` accepts `aws`, `azure` and
   `gcp` and implements none of them, so the only provider that works is the local
   static key the environment schema forbids in production. Until an adapter
   exists there is no configuration in which the process starts _and_ keeps the
   key-encryption key outside its own environment, which is the central claim of
   ADR 0002. The Terraform module already provisions the AWS key, so `aws` is the
   one to write; the interface is four methods and the adapter is testable against
   a stubbed client exactly as the Gmail and Graph adapters are.
2. **The cluster itself.** The Terraform module provisions the data layer, the KMS key and
   the secret; it deliberately does not create an EKS cluster, because every organisation
   with Kubernetes already has an opinion about how clusters are made and a module that
   insisted on its own would be forked or ignored. What is missing is the glue: a VPC, the
   subnet groups and security groups the module takes as inputs, and External Secrets wired
   from the Secrets Manager secret into the namespace.
3. **More metrics than queue depth and request rate.** The worker exports
   `wea_queue_depth` and the API now exports its request counters and latency histogram,
   which between them cover the backlog, error-rate and p95 alerts. Still unexported and
   still only a log line: a mailbox stuck in `polling`, a user's token budget exhausted,
   the retention sweep failing quietly. Each is a condition the code already knows and
   writes an `event` field for, so what is missing is the export rather than the detection.
   The worker's own work is also unmeasured — job duration and failure rate per queue would
   say _why_ a backlog is growing, where depth only says that it is.
4. **E2E, load and security suites (Phase 10).** The integration tests reach a real database
   but stub every third party. What is untested end to end is the seam with Meta and with
   Google, which is where a contract changes without telling anyone. `pnpm preflight` narrows
   this — it exercises both seams for real — but it checks that they are reachable and
   configured, not that a message round-trips.
5. **A real end-to-end run.** `docs/getting-started.md` is the ordered walkthrough and
   `pnpm preflight` verifies each seam, but nobody has yet taken a live Meta app and a live
   Gmail account from clone to a reply landing in someone's inbox. Every claim in that
   document is checked against the code; none of it is checked against Meta.

An earlier revision of this paragraph said every feature in the product spec was built.
The parity audit above is what that claim looks like when it is checked verb by verb, and
it is not true. Composing, attachments in both directions, Cc and Bcc have since been
built; what is missing now is on the other half — the filing verbs beyond archive, which
are labels, folders and snooze.

### After that

- Dashboard views beyond connect-and-configure — a mail list, a message reader, an audit-log
  view. The shell exists (Phase 9): sign in, connect and disconnect mailboxes, verify a phone,
  edit every notification setting. Nothing in it reads mail, which is deliberate for now —
  mail is what WhatsApp is for, and every additional view is another surface holding it.
- E2E, load and security test suites; CI pipeline (Phase 10)
- Dockerfiles, Kubernetes manifests, Terraform, monitoring (Phase 11)
- React Native app, GraphQL, public SDK, IMAP

### Deliberately deferred

- **Partitioning `email_messages` by month.** The schema is ready; the operational cost is
  not justified until volume demands it.
- **Sharding by `user_id`.** No cross-user joins exist anywhere, so this stays a deployment
  change rather than a rewrite.
- **Autonomous agentic email handling.** See ADR 0004 — an agent driven by
  attacker-controlled text is not something we can secure today.
- **A cross-tenant analysis cache.** The same newsletter reaches thousands of mailboxes and
  analysing it thousands of times is the largest avoidable cost here — but reading another
  user's analysis means an unscoped read of `email_messages`, precisely the widening that
  was refused for the watch sweep. The version worth building keeps the derived analysis in
  its own table, keyed by content hash and carrying no user id at all, the same shape as
  `provider_account_routes`.

---

## Findings worth carrying forward

Things that surfaced during the build and would have been expensive to discover later.

**The precondition for 283 tests existed only in one shell's history.** The hardening
migration creates the application role `wea_app` as `NOLOGIN`, which is right for
production. Every isolation assertion in the project requires _connecting_ as that role,
because Postgres exempts the table owner from row-level security — and nothing in the
repository ever gave it a password. It worked here because it had been typed by hand
months ago. A fresh clone would have run `pnpm test:integration`, watched every
database-backed test skip itself, and seen green. Setting up CI is what surfaced it: a
pipeline has no shell history. Now `pnpm db:test-role` is a checked-in script that also
refuses to proceed if the role would bypass RLS, and it runs in CI and in first-run setup
alike. The general shape is the familiar one from this project — **a safeguard that is
silently absent looks exactly like one that is present** — arriving this time as an
environment step rather than a line of code.

**A natural-language question is a poor keyword query, and that is visible without
embeddings.** Question answering reuses the hybrid search that powers `search`, and with a
model provider configured the semantic arm carries it. Without one, the retrieval falls back
to full-text and trigram over a _sentence_ — and "what did sarah want?" shares no term with
any subject or snippet, so it legitimately retrieves nothing. The integration tests are
written against that reality rather than around it: the questions that retrieve share
vocabulary with the fixtures, and one test pins what happens when none does — we say we found
nothing rather than asking a model to answer from an empty set. The general point is that a
feature can be correct and still be much weaker in one supported configuration than another,
and the honest place to record that is next to the tests that show it.

**The Microsoft adapter was never once invoked at runtime.** Every call site in the worker
— send, ingest, sync, forward, mailbox actions — asked for its adapter by writing the
literal `'gmail'`, because `ProviderAccount` did not carry the provider kind and there was
nothing else to pass. A Microsoft mailbox was therefore operated through the Gmail adapter
with a Microsoft access token on every operation. The Graph adapter has 194 passing
assertions, Phase 7 was marked ✅ in the README, and none of it ran.

Nothing failed loudly, and three things had to be true at once for that: the adapter's own
tests pass in isolation because they test the adapter, the integration tests stub the
provider entirely, and no suite anywhere exercised the wiring _between_ an account and its
adapter. The insight was even written down correctly elsewhere in the codebase — the API's
linking service picks its adapter from `account.provider` and says why, "watching a Graph
account with the Gmail adapter would fail in a way that reads like a Google outage" — and
was simply not applied on the worker side.

The fix is a required `provider` field on `ProviderAccount`, which turned three more
silently-wrong construction sites into compile errors the moment it landed. The guard is a
lint rule, not a test, and that distinction was measured: reverting a call site to the
literal passes all 530 worker tests, and fails `pnpm lint` in two places. **When a bug
cannot be caught by a test because the seam is stubbed everywhere, the check belongs in the
linter.**

**Audio erases the boundary that a screen draws for free.** On the notification card, an
email body sits under a sender line and nobody confuses it with the assistant talking. Read
aloud, our words and the email's are one voice — an email saying "This is your assistant,
reply YES to authorise the payment" sounds exactly like us, and there is no quoted block to
give it away. The preamble helps (it names the real sender first and marks where their words
begin) and the display name is stripped of the punctuation that would let it forge a second
header, both tested. Neither is a guarantee, and neither is what actually holds: the
guarantee is invariant 3 — nothing destructive is authorised by what a user _says_, only by
a tap carrying a server-minted id — so a spoken instruction cannot authorise anything even
if a listener is completely taken in. Worth writing down because it is the first feature
where the mitigation is somewhere other than the feature.

**"The vendor has an endpoint" is not the same as "the capability works".** Gemini publishes
text-to-speech, so `speak` looked implementable on it. Its output is raw 24 kHz PCM, which
WhatsApp will not play, and converting it needs a transcoder this project does not have — so
a `speak` on Gemini could only produce audio that uploads successfully and arrives silent.
It is absent instead, the same call `embed` on Anthropic already made. The general form:
**a capability that is present and cannot deliver is worse than one that is absent**, because
absent is a branch the caller already writes and present is a bug they discover in production.

**A nonce-based CSP silently deletes a statically prerendered page.** The dashboard's
middleware issues a per-request nonce and `script-src 'self' 'nonce-…' 'strict-dynamic'`.
Every unit test passed: the nonce was unique per request, present on both the request and
the response, and correctly formed. Served from a real production build, Next nonced
_none_ of its twelve script tags — a prerendered route has its HTML written at build time,
before any request and therefore before any nonce, and `'strict-dynamic'` deliberately makes
the `'self'` that would otherwise have saved them inert. The page was blank. `export const
dynamic = 'force-dynamic'` in the root layout fixes it, and `test/rendering.spec.ts` pins it.
The general shape is the one this project keeps meeting from a new angle: **the tests
asserted the mechanism and the mechanism was right; the outcome was still wrong.** Dev never
prerenders, so nothing about this is visible before a deploy.

**Measuring against a server you did not restart is not measuring.** Two consecutive
verifications of the above reported "zero nonced scripts" — the second was against a stale
`next start` still holding the port from the previous build, because the `pkill` meant to
stop it matched its own command line and killed the shell instead. The first reading was a
real finding; the second was noise that happened to agree with it, which is the worst kind.
The fix that mattered was checking `EADDRINUSE` in the server log before trusting the curl.

**`tsc` and webpack disagree about `./api.js`.** Under `moduleResolution: "Bundler"`,
TypeScript accepts a `.js` specifier as an alias for the `.ts` file next to it; Next's
webpack does not resolve it at all. The typecheck was clean and the build failed. Within
`apps/web`, relative imports are extensionless — matching what every other file there
already did, which is how the odd one out was spotted.

**A test that proves a loop by hanging is not a passing signal either.** Removing the
retry guard in the API client sends it into an unbounded refresh loop that spins on
microtasks alone — which starves the timer vitest's own 5-second timeout depends on, so the
suite hangs indefinitely rather than failing. The stub now refuses to answer past a small
budget, turning a hung CI job into a red one in twelve milliseconds.

**Postgres exempts superusers from row-level security.** The isolation tests initially
passed _vacuously_ — the policies existed, `\d` displayed them, and nothing was enforced,
because the connection was the database owner. `assertTenantIsolationEnforceable()` now
refuses to boot on a superuser or `BYPASSRLS` connection, and an integration test asserts
it. **The application must connect as `wea_app`, never as the owner.**

**`Buffer.from(x, 'base64')` never throws on invalid input.** It silently discards bad
characters and returns garbage, so a `try/catch` around encoded-word decoding is dead code.
Base64 syntax now gets validated before decoding.

**An empty plaintext seals to exactly IV + tag.** A `<=` length guard rejected it as
truncated — and an email can legitimately have an empty body.

**`eslint --fix` can break NestJS dependency injection.** The
`consistent-type-imports` rule rewrote all six injected classes to `import type`, which
erases the runtime binding `emitDecoratorMetadata` needs. Typecheck passed, unit tests
passed, and it would have failed at boot in production. The rule is off for the DI layers,
and `apps/api/test/di.spec.ts` asserts `design:paramtypes` survives — running against
`dist/`, because vitest transpiles with esbuild, which does not implement
`emitDecoratorMetadata` at all.

**Auth tables cannot be gated on the tenant they are consulted to establish.** `sessions`
and `api_keys` were placed under `tenant_isolation` in the original hardening migration,
which meant a refresh token could never be looked up: the lookup is by hash, before any
tenant is known. Authentication simply could not work. The fix relaxes _reads_ when no
tenant context is set, while leaving writes strictly owner-scoped — verified directly in
`psql`. What it gives up is that an unscoped `SELECT * FROM sessions` returns rows rather
than none; what those rows contain is a SHA-256 hash, a user agent and an IP, not a usable
credential.

**The fallback and the bug were the same shape.** Polling exists for mailboxes whose watch
could not be established, and it turned out to need no new state at all: a null expiry on
`provider_account_routes` already means "no push subscription", is written when a watch
fails and cleared when one succeeds, and can be read without a tenant — which is exactly
what a scheduled sweep needs. It also stops on its own. The reason it is a dozen lines
rather than a second pipeline is the cursor fix below: polling and push now reach the same
ingest path two different ways, because ingest resumes from what it stored rather than from
whatever the caller hands it.

**A stub that ignores the contract hides the bug the contract exists to prevent.** Ingest
walked history from the cursor _on the job_. A Gmail push carries the mailbox's position
**now**, so `history.list` started at "now" and returned nothing: every push was handled
successfully, logged as a success, and found no mail. The push path was inert. Worse, the
cursor was then advanced to the last _message id_ seen — and a message id is not a
historyId, so the next sync started from a value Gmail cannot interpret and the mailbox
never synced again.

Neither was caught, because the test stub yielded from a fixed array regardless of the
cursor it was handed and had no return value at all. The signature now makes the mistake
hard: `fetchChanges` returns the provider's new cursor as the generator's _return_ value,
so a caller cannot derive one from the last change it happened to see. The stub honours
that contract, and six tests pin the behaviour — including one asserting that a push
actually finds mail, which is the whole point of the feature.

**A delimiter an attacker can close is a decoration.** Wrapping email content in `<email>`
tags achieves nothing: the email writes `</email>` and continues with instructions. The
envelope's tag is a fresh 128-bit nonce per call, which content written before the call
existed cannot guess, and anything envelope-shaped is stripped from the content so a prompt
never contains two plausible envelopes. The reminder that the block is data goes _after_ it,
because models weight later tokens more heavily. None of this is a guarantee — ADR 0004's
architecture is what makes a landed payload harmless — but it is the difference between a
boundary and a suggestion.

**Do not ask a model whether it is being manipulated.** The text in front of it is exactly
the input that would produce a reassuring answer, and a compromised answer is
indistinguishable from an honest one. Instruction-like text is detected by regex, and that
detection can only ever _raise_ the warning — the model's "false" is not evidence of
anything. Tuning is precision-first, because the flag becomes a warning on someone's phone
and this is a warning rather than a filter. The first pass flagged "I act as the treasurer
for the club", which is how a security feature becomes noise people learn to ignore.

**A settings row that also holds a promise.** `user_preferences` carries `retentionBodyDays`
alongside the notification settings — how long we keep someone's message bodies, which is a
commitment rather than a preference. A `PATCH` that spread the request body onto the row would
have let any client extend it, silently, and nothing would have surfaced that until somebody
went looking. So the update is an allowlist rather than a spread, and the test that matters
most in that file is the one asserting `retentionBodyDays` cannot be reached.

The same file rejects rather than coerces, for a related reason: a malformed digest time that
gets dropped is a digest that silently never arrives, and the user cannot tell that apart from
the product being broken.

**A column that reads as a safeguard and is not one — this time holding private mail.**
`phone_verified` was in the first migration and read by no code. That made three things true
at once, and none of them theoretical. A typo at signup sent someone's inbox summaries to a
stranger's phone, with nothing anywhere to catch it. Because `phone_number` is `UNIQUE`,
claiming a number you did not own also _squatted_ it, so its real owner could never register.
And an inbound WhatsApp message resolves by number, so the squatter's mailbox was the one a
victim's commands acted on.

The seal is one line in one place: `findDeliveryContext` returns null for an unverified
number, and every notification path already guards on that being present. Adding a second
check at each call site would have worked until somebody added a third call site.

Four integration fixtures started failing the moment it landed, all of them users with a
number nobody had verified — which is the check working, and is the most convincing evidence
available that it was doing nothing before.

**Verification runs inbound, and the obvious direction does not work.** Sending a code _to_
the number needs an approved template, because Meta forbids free-form messages to anyone who
has not messaged you in 24 hours. So the code goes the other way: the dashboard shows it, the
user sends it from the phone they are claiming. That proves possession just as well, needs no
template, and opens the messaging window at exactly the moment the first notification will
need it. The code alphabet excludes every pair that is ambiguous on a phone screen — no O/0,
no I/1/L — because a substitution the user makes reading it back would otherwise be a code
that was never issued.

**A guard that was written, exported, and never attached.** Both OAuth `start` endpoints read
`req.user` and refused when it was absent, under a comment explaining that the auth guard was
not built yet. It had been built, and exported from `AuthModule`, and `OAuthModule` imported
that module — and neither controller applied it. So `req.user` was never populated and the
entire connect flow answered 401 forever: two providers, an adapter each, and no way to
connect either. The comment had been true when it was written, which is the whole problem
with comments that describe the state of the world rather than the reasoning.

The fix is not only the decorator. A browser navigating to a redirect endpoint cannot send a
bearer token, so `start` could be authenticated _or_ reachable, not both — it returns the
consent URL as JSON now and the caller navigates. `callback` stays unguarded because the
provider redirects a browser to it, which also carries no token; identity comes from the
signed `state`, which is exactly what `state` is for.

And the tests that would have caught it are a different kind from the ones that did not. Every
existing test called the handler directly, which proves nothing about what runs in front of
it. The guard is now asserted from the decorator metadata — the same trick as the DI spec,
for the same reason: the thing that broke was invisible to every test that exercised
behaviour.

**A second provider is where you find out whether the port was real.** Everything above
`MailProvider` was written against Gmail and claimed to be provider-neutral. Adding Graph
changed no caller, no processor and no query — which is the only evidence that claim was
ever worth anything. What it did change is two things the port had quietly assumed: that a
renewal returns the same subscription id it was given (Graph's can differ, because a PATCH
that finds the subscription gone falls back to creating one), and that `watch` needs only an
access token (Graph's delta walk can outlive one). Both were additions to existing signatures
rather than new concepts, which is roughly the cost a good port should have.

**The same verb, three incompatible meanings.** Gmail's `watch` is idempotent, so renewing it
is re-issuing it. Graph's `POST /subscriptions` creates a _second_ subscription — a renewal
written the Gmail way delivers every notification twice and leaks one more subscription every
three days until the per-mailbox limit rejects the next. Gmail's cursor is a number that
survives anything; Graph's is a URL, and the one that must be stored is the `@odata.deltaLink`
from the final page rather than the `@odata.nextLink` that expires in minutes. Gmail preserves
the `Message-ID` in an uploaded MIME; Graph replaces it, so storing ours would mean a reply to
our reply quotes an id we never see again. None of these produces an error — each is a
mailbox that looks connected and quietly stops working.

**A field you do not ask for is a feature that silently does not exist.** Graph omits
`internetMessageHeaders` entirely unless it is named in `$select`, and that is the only place
`In-Reply-To` and `References` live. Without them the adapter still returns messages, still
sends replies, and still passes every test that does not look at threading — while every reply
starts a new conversation in the recipient's client. The `$select` list therefore lives next
to the normalizer that depends on it, rather than in the client that issues it.

**A webhook with a handshake before it has anything to authenticate with.** Graph POSTs a
validation token to the notification URL _while creating the subscription_ and expects it
echoed as `text/plain` within ten seconds. Get it wrong and the subscription is never created
— and the error names the URL rather than the handshake. It is answered before any
authentication because there is none yet: no subscription exists, so there is no `clientState`
to compare. After that, `clientState` is the whole of the authentication, because Graph does
not sign notifications — so it is compared in constant time, a missing configured secret
refuses everything, and one valid entry in a batch does not authenticate the rest.

**Two confirmations, one button, one slot.** A forward's confirmation and a drafted reply's
confirmation are both buttons carrying `confirm_send` — so with a pending slot each, a tap on
the draft would have reached for the forward's, and the user would have watched their mail go
somewhere they never chose for reasons they could never reconstruct. It was not reachable
before drafting existed, and would have become reachable the moment it did. There is one
slot now, with a discriminant, and one branch. The lesson generalises past this instance:
when two flows share an authorization token, they have to share the thing it authorizes.

**The most dangerous output in the system is the one that reads most harmlessly.** Everything
else a model produces here is _shown to_ the user. A drafted reply is _sent as_ the user —
from their address, in their thread, indistinguishable from something they wrote. A wrong
summary is annoying; a wrong reply is a thing their colleague now believes they said. So
`draftReply` returns text and nothing else: no recipient, no subject, no headers, all of
which are computed server-side from the original. Nothing it returns is sent without a tap,
there is no "always send" to switch on, and the whole draft is shown rather than a preview —
a confirmation is only meaningful if the user read what they approved, and an ellipsis
mid-sentence is how someone sends a paragraph they never saw.

**The instruction goes last.** The email being replied to sits inside the envelope; the
user's instruction goes _after_ it. Models weight later tokens more heavily, and here that
ordering is the difference between answering the user and answering the email. The
instruction is also bounded — not for injection, since it is the user's own message on their
own channel and they may say what they like to their own assistant, but because an
instruction longer than the email would push the envelope out of attention. That is the one
way a user can accidentally undermine the boundary that exists to protect them.

**A summary you already paid for.** "Summarise this" looks like a model call and is not one.
Every inbound email is analysed on arrival and that analysis holds the summary the
notification card showed, so asking again would be buying the same sentence twice. The model
is reached only for a message that has none — and the result is stored, because the usual
reason one is missing is that the provider was down or the budget was spent when the mail
arrived, and both of those pass.

**24 characters is a layout constraint, not a detail.** The first version of the deadline
list put "in 3d — Send the Q3 report" in a row title. WhatsApp allows 24 characters there and
truncates silently, so what shipped would have read "in 3d — Send the Q3…" — the due date
crowding out the thing that needs doing. The task now takes the title and the date moves to
the description, where 72 characters means both fit. The test that caught it was asserting
on the wrong thing and was right to fail.

**A due date the model invented sorts to an arbitrary position.** `new Date("next Tuesday")`
is an Invalid Date rather than a throw, and an Invalid Date compares false against
everything — so a nonsense deadline does not sort last, it sorts wherever the comparison
happens to leave it. Action items are re-validated on the way _out_ of the database as well
as on the way in: the column is `jsonb`, and a schema change, a hand-edited row or a restored
backup can each put something there that the original write-time check never saw.

**Prose is the one model output with no schema, and that is the point.** A schema exists to
stop model output becoming a decision — a category that routes, a boolean that gates, a
string that reaches a provider call. A translation becomes none of those: it is shown to one
person, next to the email it came from, and nothing branches on it. What replaces the schema
is what actually matters for text on a screen — bounded, control characters stripped,
envelope markers removed so a model cannot paint a fake system message — plus the structural
guarantee that there is no tool on the port to reach for. The residual risk is stated rather
than papered over: a translated phishing line is still a phishing line, which is why the
injection warning is repeated on the summary rather than assumed to have been seen once.

**A feature that works perfectly on none of the mail people want to search.** Embedding runs
after an email is notified, so search only ever knew about mail that arrived while the
feature was on. Connect a mailbox with ten years of history and every query returns nothing —
not a bug in search, which was correct throughout, but the difference between shipping a
capability and shipping a usable one. The backfill sweep queues the _same_ `ai.embedEmail`
job ingest does, with the same id, so there is no second embedding path to keep in step with
the first and everything that makes that job safe applies unchanged. What is new is only the
restraint: a per-user batch of fifty, a budget check _before_ the query rather than fifty
jobs that each wake up and decline, a bounded window, and a completion flag so the sweep
stops asking a mailbox that has nothing left. Without that flag the sweep re-examines every
user forever and gets slower the more the product succeeds.

**Four flags that configured nothing.** `FEATURE_VOICE_NOTES`, `FEATURE_SEMANTIC_SEARCH`,
`FEATURE_AUTOMATIONS` and `FEATURE_IMAP` were validated, documented in `.env.example`, and
read by no code at all — the same failure as the AI provider that validated and did nothing,
found while looking for somewhere to gate the backfill. Setting `FEATURE_SEMANTIC_SEARCH=false`
did not disable semantic search; it did nothing whatsoever. They are gone. A flag arrives with
the code that reads it, or it is a comment pretending to be configuration.

**A setting that reads as on and behaves as off.** `AI_PRIMARY_PROVIDER` accepted `gemini`
and `anthropic`; the env schema even refused to boot without the matching key, so selecting
one felt validated. Only OpenAI was implemented. The service's switch fell through to
"no provider configured", logged one info line, and every email shipped without a summary —
for as long as nobody looked. The fix is not a third adapter, it is that the fall-through no
longer exists: an unrecognised name throws at construction. Adding the two adapters is what
makes that throw survivable.

The mirror image was in the same file. Because `AI_PRIMARY_PROVIDER` _defaults_ to `openai`,
a defaulted value counted as a deliberate selection, so the schema demanded a key — and the
"no AI configured" deployment the worker is carefully written around could not actually
start. `none` is now sayable. A blank key is still an error, because a blank key is far more
often a mistake than an intention.

**Not every provider has every capability, and pretending otherwise costs a round trip.**
Anthropic publishes no embeddings API. An `embed` that satisfied the port could only throw,
and a caller cannot tell "will always throw" from "might work" without making the call —
paying latency, a log line and possibly money to learn something knowable at construction.
`embed` is optional on the port instead, and `canEmbed()` is the narrowing both call sites
use. Selecting Anthropic gives full analysis and keyword-only search, which is a real
configuration rather than a broken one, and the boot log says which it is.

**Three APIs, three different ways to look successful while failing.** OpenAI returns a
choice with no content. Gemini returns **HTTP 200** with no text and a `finishReason` of
`SAFETY` — a success as far as `fetch` is concerned, and an empty analysis if nobody checks.
Anthropic has no JSON mode at all, so JSON comes from prefilling the assistant's turn with
`{` — which is not echoed back, so an adapter that forgets to put it on again produces valid
JSON minus its opening brace, parses to nothing, and looks like a bad model rather than a bad
adapter. Gemini also splits long responses across parts; taking the first silently truncates.
Each of those is one test.

**Row-level security does not check a foreign key.** Storing an embedding wrote
`(user_id, email_message_id)` from literal values. RLS checks the row being _written_ —
`user_id` was ours, so every policy passed — but Postgres runs referential-integrity
triggers as the table owner and exempts them from policies entirely, so nothing objected to
Alice writing a row pointing at Bob's message. It leaks nothing, because the read path joins
`email_messages` and that join is scoped. The damage is the unique constraint on
`email_message_id`: Alice's row squats on the one Bob's own job needs, and his embedding
never lands. A cross-tenant denial of service through a column nobody would think to check.
The insert now sources the id from a scoped `SELECT` over `email_messages`, so another
tenant's message produces no row at all. The integration test asserted a rejection, got a
success, and that is how this was found — the assertion was written expecting RLS to be
enough.

**Three search scores are three different units.** Cosine distance, `ts_rank` and trigram
similarity cannot be added, and any weighting that makes them comparable is a constant
someone tuned once against one corpus and nobody can defend afterwards. Reciprocal rank
fusion sidesteps it: each list contributes `1/(60 + rank)`, ranks are comparable by
construction, and a result two arms agree on outranks one that only a single arm found —
which is the property the whole hybrid exists for, and is asserted rather than assumed.

**An embedding gets no envelope, and that is a decision.** Untrusted email content is
wrapped in a nonce-delimited envelope everywhere it reaches a model — except here. An
embedding model receives no instructions, so there is no system prompt for injected text to
argue with, and the output is 1536 numbers rather than a sentence anyone acts on. Stripping
instruction-like text would be worse than useless: it would change the email's meaning and
therefore where it sits in the vector space, making a message harder to find because of what
someone else wrote in it. What does carry over is neutralisation — control characters
stripped, length bounded — because that is about what we are willing to put on the wire.

**A pure class earns its purity by not being extended.** `search` and the standing lists are
reads over the whole mailbox, and the obvious move was a branch in the response planner. That
would have given a class whose entire value is that it touches no database a repository, for
four intents out of twenty-three. They are answered before the planner is called instead, and
the planner's switch now documents the absence so removing the interception falls through to
a visible default rather than a silent mishandling.

**"Deferred" is a politer word for "dropped" until something delivers it.** `decideDelivery`
had returned `defer` since the beginning and nothing recorded the decision, so afterwards
"held back" and "delivered" were indistinguishable and the mail was simply gone. The fix is
a timestamp per message and two triggers: the moment the user next messages us, because
that is when the window reopens and is the path that actually matters; and their own
scheduled times, as a backstop for someone who never texts. The backlog is cleared only for
what was actually shown — the out-of-window template announces waiting mail without showing
it, so clearing there would lose exactly the mail it just promised.

**Outside the messaging window, the API lies to you.** Meta accepts a free-form message sent
past the 24-hour customer service window, returns a message id, and never delivers it. There
is no error to catch and no bounce to observe — just a user who stops hearing from us. Only
a pre-approved template gets through, and a template's text is fixed at approval time, so it
cannot carry a summary or a working button. It can only be a nudge: get the user to reply,
which reopens the window, after which the real card can be sent. The one code path allowed
past the window check takes an explicit `allowOutsideWindow` flag and throws if the payload
is anything but a template — because a general escape hatch here fails silently by
construction.

**A parameter order that fails closed still fails.** `verifyPassword(hash, password)` takes
the stored hash first, and returns false on any error rather than throwing — so calling it
the other way round produces no crash, no log line, and no failing type check. It simply
tells the user their password is wrong, forever. It reached the disable-2FA path and was
caught only because an integration test tried to actually turn the factor off. Fail-closed
is the right default and it is not a substitute for getting the call right.

**Enabling a second factor is the moment you can lock someone out.** Two things follow, and
neither is obvious until it has happened to someone. Enrolment has to be two steps — store
the secret, then enable only once the user produces a working code from it — because a
secret that never reached an authenticator app is an account nobody can sign in to. And the
session that completed enrolment has to be marked as having satisfied the factor, because
the code it just used is now spent and the next one is up to thirty seconds away: without
that, turning 2FA on locks you out of the page you turned it on from.

**Storing something is half a decision; erasing it is the other half.** Ingest stored only
a 300-character snippet, which left `body_text_cipher` and the envelope encryption the
schema describes for it as dead weight — and would have left the AI layer with nothing to
read. Bodies are now sealed at ingest, and the retention sweep that `RETENTION_BODY_DAYS`
always implied now exists to erase them. Shipping the storage without the purge would have
turned a stated retention policy into a comment, and the difference stays invisible until a
breach makes it very visible. A body is truncated at 256 KB — past that it is markup and
inline images, not something a person wrote — and a failure to encrypt stores the message
without its body rather than dropping the email, because a notification the user receives
beats mail they never hear about.

**A confirmation must not carry what it authorizes.** A forward's recipient never travels
on the button. WhatsApp echoes an interactive id straight back to us, so an address placed
there would be an address the client could change — and a forward to the wrong person
cannot be recalled. The recipient is written to the conversation's pending action when the
user types the command, and reading it clears it, so a replayed tap can at most
re-authorize the forward they already described, and a second tap sends nothing at all.

**A plan that is not executed is worse than no plan.** The response planner returned
`followUp: 'queue_send' | 'queue_action'` and the processor only logged it — so the worker
replied "Archived." and "Sending your reply…" without archiving or sending anything. Every
test passed, because each half was correct on its own and nothing asserted the join. The
fix is structural rather than a patch: the plan now carries a concrete `effect`, the
processor carries it out **before** replying, and the sentence the user receives describes
the outcome instead of the intention. A planner invariant test now pins `effect` to
`followUp` in both directions, and the integration tests assert against the database and
the provider stub rather than against the message we sent.

**A button can outlive what it points at.** A tap from an old notification names an email
that may since have been purged. Passing that id straight through violated the delivery
record's foreign key, which threw, retried, and left the user with no answer at all — the
one outcome the whole "always reply" rule exists to prevent. The target is now resolved
before anything references it.

**A scheduled job has no tenant, and row-level security has no way to express that.** The
watch-renewal sweep runs on a timer on behalf of everyone, so a cross-tenant read of
`email_accounts` would return zero rows under the policy — and the two obvious fixes are
both bad: relax RLS on the table holding OAuth token ciphertext, or run the sweep as a role
that bypasses RLS entirely. Neither is worth it for a scheduling problem. The expiry is
mirrored instead onto `provider_account_routes`, which is already outside tenant isolation
because it is consulted to _determine_ the tenant, and which carries no secrets. The sweep
learns which mailboxes need renewing; the renewal itself still runs fully tenant-scoped.
The cost is two columns that must not diverge, so both are written in one transaction, and
an integration test asserts the sweep still cannot read or write another user's mailbox.

**Renewing a subscription must not move the sync cursor.** Gmail hands back its current
`historyId` when a watch is re-issued. Storing it would silently skip every message between
the position we had and the moment of renewal — mail the user never hears about, caused by
the very job that exists to keep mail flowing. The cursor is written on renewal only when
the account has none.

**Prisma's `upsert` cannot write an ownerless row under RLS.** It emits
`INSERT ... ON CONFLICT DO UPDATE`, and Postgres evaluates the policy's `USING` clause on
that path — which is NULL for a row with no owner, so the write is refused even though the
`WITH CHECK` permits it. A plain insert passes. `createMany({ skipDuplicates: true })`
compiles to `ON CONFLICT DO NOTHING`, which is both the working form and the correct
intent: record the message once, and let a redelivered webhook be a no-op.

**Sanitizing a MIME type is not enough.** Stripping the dangerous characters from
`text/plain";\r\nX-Evil: 1` leaves `text/plainX-Evil: 1`: no longer an injection, but a
malformed `Content-Type` a lenient parser may misread. MIME types are now validated against
RFC 2045's grammar, with anything malformed becoming `application/octet-stream`.

---

## Invariants that must not regress

Each of these has a test. They are the load-bearing ones.

1. **No fingerprint on outbound mail.** `composeMime` emits no header outside
   `ALLOWED_HEADERS`; the word "whatsapp" appears nowhere in a composed message. Adding a
   branding header fails CI.
2. **`References` trims from the middle.** Trimming from the end discards the parent and
   detaches the reply from its own thread.
3. **The model never authorizes an action.** Destructive verbs are parsed deterministically
   and require a confirmation tap carrying a server-minted target id.
4. **Decryption failures are indistinguishable.** Wrong key, tampered ciphertext and
   mismatched AAD all raise one identical error.
5. **Tenant context is transaction-scoped.** `SET LOCAL`, never `SET`, so a pooled
   connection cannot carry one user's context into the next request.
6. **Under genuine ambiguity the resolver never picks an email.** It asks. A misrouted
   reply sends someone's words to the wrong person and cannot be undone.
   6b. **A recognised user always gets an answer.** Silence is the one response people read
   as "it's broken", so every intent — including ones we cannot serve yet — produces a
   reply that names what is missing.
7. **An email is stored once and notified once, however often it is redelivered.** Gmail
   redelivers history freely and the reconcile sweep re-walks it on purpose; persistence
   reports whether it created the row, and only the creator notifies.
8. **A reused refresh token revokes its whole family.** Presenting an already-rotated token
   is impossible for a legitimate client, so it means two parties hold it. The response
   logs out both — the user re-authenticates once; the attacker is out.
9. **OAuth `state` is signed, expiring and carries the connecting user.** The callback
   never infers identity. Every rejection returns one identical public message, so a
   forgery attempt learns nothing about why it failed.
10. **A reply is sent at most once.** The draft claim is a conditional write, so two
    workers racing on one draft means exactly one send. Tested with genuinely concurrent
    claims against Postgres, not two calls to a mock.
11. **Search results carry server-minted ids.** Every row in a search or list payload is an
    `open_thread` action over an email read from the user's own mailbox under RLS, so nothing
    a search returns can widen what the tap after it is allowed to touch.
12. **Webhooks verify before parsing and acknowledge before working.** Both the WhatsApp
    and Gmail endpoints reject unauthenticated requests before touching the payload, respond
    before doing work, and always return 2xx once authentic — so a bug on our side cannot
    make a provider redeliver forever. Missing raw bytes
    fail closed; an authentic payload always gets a 200 so a bug here cannot trigger
    endless redelivery.
13. **A model is never given an email id.** Question answering numbers its sources 1..n for
    the length of one call and maps the numbers back itself. There is no id in the model's
    context to leak, repeat, or be induced to emit, so a fabricated citation resolves to
    nothing rather than to a row — the row ids the user taps stay server-minted by
    construction rather than by validation.
14. **A question is a read.** Nothing on the path from a free-form question to its answer can
    mutate a mailbox or send mail, whatever the answer says. Asserted by making the model
    claim it deleted everything and checking that it did not.
15. **The dashboard's access token never reaches persistent storage.** It lives in a module
    variable and dies with the tab; the refresh token is an HttpOnly cookie script cannot
    read. Persisting the access token would turn any XSS on that origin from a session-length
    problem into a permanent one.
16. **A 401 refreshes once, and concurrent 401s refresh together.** Refresh tokens rotate on
    use, so a second concurrent refresh presents an already-rotated token and correctly trips
    invariant 8 — the user is signed out of everything by their own dashboard loading. Both
    the single-flight promise and the single retry are pinned by tests that fail fast rather
    than hang.
