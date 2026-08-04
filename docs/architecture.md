# Inbox on WhatsApp — System Architecture

> Manage email entirely from WhatsApp. Users connect Gmail / Outlook / Microsoft 365 once;
> every inbound email arrives as a WhatsApp message, and every WhatsApp reply goes out as a
> normal, correctly-threaded email. The recipient never sees a trace of WhatsApp.

**Status:** Phase 1 — architecture baseline.
**Audience:** engineers, SRE, security reviewers.

---

## 1. Design goals and non-goals

### Goals

| Goal | Target |
| --- | --- |
| Email → WhatsApp latency (p95) | < 5 s from provider push to WhatsApp delivery receipt |
| WhatsApp reply → SMTP send (p95) | < 3 s |
| Availability | 99.9 % on the ingest + reply path |
| Scale | 10 M connected mailboxes, ~50 M inbound emails/day at peak |
| Thread fidelity | 100 % of replies carry correct `Message-ID` / `In-Reply-To` / `References` |
| Tenancy | Hard per-user data isolation; per-organization roles |
| Secrets | No password ever stored; OAuth refresh tokens encrypted with envelope encryption |

### Non-goals (deliberately out of scope for v1)

- Being a full mail client. We do not render arbitrary HTML email; we render a normalized,
  AI-summarized projection of it.
- Storing full mailbox history. We store **metadata + a bounded body cache** (see §7),
  never a complete mirror of the user's mailbox.
- Real-time collaborative inboxes (Front/Missive-style). Teams exist for billing and
  administration, not shared triage, in v1.

### The one hard constraint that shapes everything

**WhatsApp's 24-hour customer service window.** A business may only send free-form messages
within 24 h of the user's last inbound message. Outside it, only pre-approved *template*
messages are allowed. This is not a detail — it dictates the entire notification design
(§6.3). Every outbound path must decide, at send time, whether it is in-session or must
degrade to a template.

---

## 2. Architecture at a glance

```
                                   ┌────────────────────────────────────────┐
                                   │        Meta WhatsApp Cloud API         │
                                   └────────▲───────────────────┬───────────┘
                    inbound webhook         │                   │ outbound send
                    (messages, statuses)    │                   ▼
┌──────────────┐   ┌────────────────────────┴───────────────────────────────┐
│ Gmail push   │   │                   apps/api (NestJS)                    │
│ (Pub/Sub)    ├──►│  /webhooks/*  /v1/* REST  /graphql  /oauth/*  /health  │
│ Graph subs   │   │  stateless · horizontally scaled · signature-verified  │
│ IMAP IDLE    │   └───────────────┬────────────────────────────┬───────────┘
└──────────────┘                   │ enqueue (fast ack)         │ read/write
                                   ▼                            ▼
                   ┌───────────────────────────────┐   ┌────────────────────┐
                   │      Redis / BullMQ queues    │   │    PostgreSQL      │
                   │  ingest · ai · notify · send  │   │  (row-level scoped)│
                   │  sync · automation · dlq      │   │  + pgvector        │
                   └───────────────┬───────────────┘   └────────────────────┘
                                   ▼
                   ┌───────────────────────────────┐   ┌────────────────────┐
                   │      apps/worker (NestJS)     │◄─►│  Object storage    │
                   │  ingest→normalize→AI→notify   │   │  (S3: attachments) │
                   │  send · sync · automations    │   └────────────────────┘
                   └───────────────┬───────────────┘
                                   ▼
                   ┌───────────────────────────────┐
                   │  LLM providers (OpenAI /      │
                   │  Gemini / Anthropic) + ASR    │
                   └───────────────────────────────┘

        apps/web (Next.js dashboard) ─────► apps/api
        apps/mobile (React Native)   ─────► apps/api
```

Two deployables carry the product: a **stateless API** that only ever validates, persists and
enqueues, and a **worker fleet** that does everything slow or fallible. Nothing that can take
more than ~100 ms happens inside a webhook request.

---

## 3. Service decomposition

We ship a **modular monolith split into two runtimes**, not a constellation of microservices.
The module boundaries below are enforced in code (separate NestJS modules, separate packages,
no cross-module repository imports) so any module can be extracted into its own service when a
specific scaling or ownership pressure justifies it — but on day one, two deployables mean one
schema migration path, one trace, one deploy.

| Module | Runtime | Responsibility |
| --- | --- | --- |
| `auth` | api | Signup/login, JWT access+refresh, TOTP 2FA, sessions, RBAC |
| `accounts` | api + worker | OAuth connect flows, token refresh, mailbox watch renewal |
| `webhooks` | api | Meta + Gmail Pub/Sub + Graph endpoints; verify → enqueue → 200 |
| `ingest` | worker | Fetch message, normalize MIME, dedupe, persist, fan out |
| `ai` | worker | Summarize, classify, extract, translate, draft, embed |
| `notify` | worker | Render WhatsApp payload, session-window logic, send, track |
| `commands` | worker | Parse WhatsApp inbound → intent → action, conversation state |
| `send` | worker | Compose RFC 5322, thread headers, send via provider |
| `automations` | worker | Rule engine, reminders, escalations |
| `search` | api | Keyword + semantic (pgvector) search |
| `billing` | api | Stripe subscriptions, plan limits, metering |
| `analytics` | api | Aggregates, exports |
| `admin` | api | Operator surface: users, queues, health, revenue |

---

## 4. Data flow: inbound email → WhatsApp

```
1. Gmail Pub/Sub push  ──►  POST /webhooks/gmail
                            verify JWT from Google, extract historyId
                            enqueue { accountId, historyId } on `ingest`
                            return 204  (target < 50 ms)

2. worker: ingest
      ├─ acquire per-account lock (Redis, 30 s TTL) — serialize history cursor
      ├─ history.list(startHistoryId) → new message IDs
      ├─ dedupe on (accountId, providerMessageId) unique index → drop replays
      ├─ messages.get(format=full) → parse MIME
      ├─ persist EmailThread + EmailMessage (+ headers, participants)
      ├─ stream attachments → S3 (encrypted, per-tenant key prefix)
      └─ enqueue `ai:analyze`

3. worker: ai
      ├─ cache probe (content hash → cached analysis) — dedupes newsletters
      ├─ single structured LLM call → { summary, bullets, category, priority,
      │    urgency, language, spam_score, action_items, deadlines, entities,
      │    suggested_replies[] }
      ├─ embed body → pgvector (semantic search + "what did John ask?")
      └─ enqueue `notify:whatsapp`

4. worker: notify
      ├─ evaluate user rules (mute, digest, priority floor, quiet hours)
      ├─ session window open?  yes → interactive message with buttons
      │                        no  → approved template `new_email_v3`
      ├─ send via Cloud API; persist wa_message_id
      └─ status webhooks (sent/delivered/read/failed) update delivery record
```

**Idempotency is enforced at three layers**: the provider message ID unique index, a Redis
`SETNX` de-dupe key on the webhook payload hash (5 min TTL), and BullMQ `jobId` derived from
the same hash. Providers retry aggressively; we assume every webhook arrives at least twice.

---

## 5. Data flow: WhatsApp reply → threaded email

This is the feature. Getting it wrong is visible to the *recipient*, so it gets the most care.

```
1. POST /webhooks/whatsapp  → verify X-Hub-Signature-256 (HMAC-SHA256, timing-safe)
                            → enqueue `commands:handle`

2. worker: commands
   Resolve target thread, in priority order:
     a. message.context.id → the WhatsApp message being replied to → our delivery
        record → emailMessageId.  (Highest confidence. Native WhatsApp reply.)
     b. interactive.button_reply payload — we encode `act:reply:<msgId>` in the id.
     c. Active ConversationState for this phone number (last email addressed,
        TTL 30 min, cleared on `cancel` / topic switch).
     d. NLU resolution: "reply to Sarah" → fuzzy match over last 20 notified emails.
     e. Ambiguous → ask, with a numbered list. Never guess.

3. Intent classification (deterministic-first)
     Regex/keyword fast path for: reply, archive, delete, forward, summarize,
     translate, search, undo, send, cancel, mark read/unread/important.
     Falls through to an LLM function-calling classifier only when the fast path
     misses. ~85 % of traffic never reaches the LLM: cheaper, and far more
     predictable for destructive verbs.

4. Compose (send module)
     From:        the user's own connected address (never a proxy)
     To:          original From (or Reply-To if present)
     Subject:     "Re: " + original, de-duplicated
     In-Reply-To: <original Message-ID>
     References:  original References + original Message-ID   ← the thread key
     Body:        reply text + quoted original + user's stored signature
     Headers:     NO X-Mailer, NO custom identifying headers.  ← non-negotiable
     MIME:        multipart/alternative (text/plain + text/html), plus
                  multipart/mixed when attachments are present

5. Send via Gmail `users.messages.send` with `threadId`, or Graph
   `POST /messages/{id}/reply`. Both providers then place the sent copy in the
   user's own Sent folder — the reply is indistinguishable from one typed in Gmail.

6. Confirm to the user on WhatsApp with an `undo` affordance (10 s soft window
   before the send job commits, where the provider permits it).
```

### Why the recipient cannot tell

- The message is sent **through the user's own mailbox**, over the user's own OAuth grant —
  same SPF/DKIM/DMARC alignment, same domain, same Sent folder.
- We add **no** `X-Mailer`, `X-Originating-*`, or branding header, and no footer.
- Threading headers are copied forward exactly, so it collapses into the existing conversation
  in every client.

---

## 6. Key subsystem decisions

### 6.1 Email provider abstraction

A single `MailProvider` port with adapters, so IMAP is a drop-in later:

```ts
interface MailProvider {
  watch(account): Promise<WatchHandle>;          // push subscription
  renewWatch(account): Promise<WatchHandle>;     // Gmail 7d, Graph 3d max
  fetchChanges(account, cursor): AsyncIterable<ChangeEvent>;
  getMessage(account, id): Promise<NormalizedMessage>;
  getAttachment(account, msgId, attId): Promise<Readable>;
  send(account, outbound: OutboundMessage): Promise<SendResult>;
  mutate(account, id, op: MailOp): Promise<void>; // archive/delete/read/flag
}
```

| Provider | Push mechanism | Cursor | Watch lifetime |
| --- | --- | --- | --- |
| Gmail | Pub/Sub `users.watch` | `historyId` | 7 days → renew daily |
| Outlook / M365 | Graph subscription webhook | `deltaLink` | ~3 days → renew every 24 h |
| IMAP (future) | IDLE, long-lived conn | `UIDNEXT`/`MODSEQ` | n/a — connection pool service |

Watch renewal is a scheduled job with jitter; a missed renewal degrades to delta polling
rather than silently dropping mail. **Polling is always the safety net** — a reconcile job
sweeps every account every 15 min and repairs anything push missed.

### 6.2 AI layer

Provider-agnostic behind an `LlmProvider` port (OpenAI, Gemini, Anthropic), selected per task
class, with automatic failover:

- **Analysis** (per email, high volume) → fast/cheap model, single structured-output call.
- **Composition** (user-visible drafts) → stronger model.
- **Classification of commands** → fast model with function calling, deterministic fallback.

Controls that matter at scale: content-hash response cache (newsletters are identical across
users), per-user + per-org token budgets enforced *before* the call, strict JSON schema output,
and a hard timeout with graceful degradation — **a failed AI call must never block delivery**.
If summarization fails, the user still gets the email on WhatsApp, just without the summary.

**Prompt-injection is a first-class threat here**: email bodies are attacker-controlled text
being fed to a model that can trigger actions. Mitigations in §8.

### 6.3 WhatsApp session window

Every outbound send passes through a `SessionWindowService`:

```
lastInboundAt within 24h ?
  ├─ yes → free-form (text / interactive buttons / list / media)
  └─ no  → approved template only
             ├─ user has notifications=instant → template `new_email_v3`
             └─ otherwise → hold, batch into next digest
```

Templates are versioned in `packages/whatsapp/templates/` and submitted to Meta for approval
via CI. Template *sends* are billable — the digest strategy is a cost control, not just UX.

### 6.4 Queues

BullMQ on Redis, one queue per stage with independent concurrency, retry and DLQ:

| Queue | Concurrency | Retry | Notes |
| --- | --- | --- | --- |
| `ingest` | high | 5×, exp backoff | Per-account lock serializes cursors |
| `ai` | medium | 3× | Rate-limited per LLM provider |
| `notify` | high | 5× | Rate-limited per WABA phone number |
| `send` | medium | 3× | Idempotency key; never double-send |
| `sync` | low | 3× | Reconcile sweep, watch renewal |
| `automation` | low | 3× | Rule evaluation, reminders |

Everything exhausted lands in a DLQ with the full job payload, visible and replayable from the
admin panel. A dropped email is a product failure — we surface it rather than lose it.

---

## 7. Data & storage

- **PostgreSQL** — primary store. Partitioned `email_messages` by month. `pgvector` for
  embeddings. Every tenant-scoped table carries `user_id` and is queried through a repository
  layer that requires a tenant context (belt) plus RLS policies (braces).
- **Redis** — queues, cache, rate limits, distributed locks, conversation state.
- **S3-compatible object storage** — attachments, SSE-KMS, per-tenant key prefix, lifecycle
  expiry matching the user's retention setting.
- **Retention** — bodies cached for a configurable window (default 30 days), metadata longer,
  attachments per plan. GDPR erasure walks all four stores plus derived embeddings.

Full schema in `docs/data-model.md` (Phase 3).

---

## 8. Security posture

| Concern | Control |
| --- | --- |
| OAuth tokens | AES-256-GCM envelope encryption; DEK per record, KEK in KMS; rotatable |
| Passwords | Argon2id; never stored for mail providers (OAuth only, by design) |
| Transport | TLS 1.2+ everywhere; HSTS preload |
| Webhook auth | Meta `X-Hub-Signature-256` HMAC (timing-safe), Google JWT verification, Graph `clientState` |
| Tenant isolation | Repository-enforced tenant scoping + Postgres RLS |
| Injection | Parameterized queries only (Prisma); no raw SQL with interpolation |
| XSS | Email HTML sanitized (DOMPurify server-side) before any rendering; CSP with nonces |
| CSRF | SameSite=strict cookies + double-submit token on cookie-auth routes |
| Rate limiting | Per-IP, per-user, per-phone-number; token bucket in Redis |
| 2FA | TOTP, encrypted secret, single-use recovery codes |
| Audit | Append-only `audit_logs` for every auth event, account link, destructive mail op |
| **Prompt injection** | Email content is delimited and labeled untrusted; the model classifies and drafts but **never authorizes an action** — every destructive verb (delete, forward, send) requires either an explicit user command or a confirmation tap. The LLM cannot call a tool that sends mail. |

Threat model and full control list in `docs/security.md` (Phase 9).

---

## 9. Scale plan

| Layer | Scaling approach |
| --- | --- |
| API | Stateless pods behind an ALB; HPA on RPS + p95 latency |
| Workers | HPA on queue depth per queue; independent scaling per stage |
| Postgres | Primary + read replicas; PgBouncer; monthly partitions; shard by `user_id` when a single primary is exhausted (schema is shard-ready — no cross-user joins) |
| Redis | Cluster mode; queues and cache on separate clusters |
| WhatsApp | Multiple WABA phone numbers, users pinned by hash; per-number rate limits respected |
| Gmail/Graph | Per-user quotas dominate; global quota tracked with a distributed limiter and backpressure into the queue |

The one genuine bottleneck at 10 M mailboxes is provider API quota, not our compute — hence
push-first, poll-as-fallback, and aggressive caching of unchanged threads.

---

## 10. Observability

- **Traces** — OpenTelemetry, propagated webhook → queue → worker → provider call. One trace
  spans the whole email→WhatsApp journey.
- **Metrics** — Prometheus. The four that page: ingest lag, queue depth, WhatsApp delivery
  failure rate, provider 4xx/5xx rate.
- **Logs** — structured JSON (pino), correlation ID per request/job, **PII-redacted**
  (addresses hashed, bodies never logged).
- **Health** — `/health/live` (process), `/health/ready` (DB + Redis + provider reachability).

---

## 11. Technology choices

| Layer | Choice | Why |
| --- | --- | --- |
| Backend | TypeScript · NestJS | DI and module boundaries that survive a large team; one language across the stack |
| ORM | Prisma | Type-safe, parameterized by construction, first-class migrations |
| Queue | BullMQ | Mature Redis-backed queues with DLQ, rate limits, repeatable jobs |
| Frontend | Next.js 15 · React 19 · Tailwind | App Router, RSC, fast |
| Mobile | React Native (Expo) | Shared TS types with the API |
| DB | PostgreSQL 16 + pgvector | Relational integrity + semantic search in one system |
| Infra | Docker · Kubernetes · Terraform | Portable across AWS/Azure/GCP as required |

Rejected: microservices-from-day-one (operational cost without the ownership pressure that
justifies it); Kafka (BullMQ is sufficient to ~100k jobs/s and far simpler; revisit when we
need replayable event history); GraphQL-only (REST is the stable public contract, GraphQL is
additive for the dashboard).

---

## 12. Delivery phases

| Phase | Contents | State |
| --- | --- | --- |
| 1 | Architecture, ADRs, repo scaffolding | this document |
| 2 | Monorepo structure, tooling, CI skeleton | |
| 3 | Database schema + migrations | |
| 4 | Backend core: auth, crypto, tenancy, queues | |
| 5 | WhatsApp integration | |
| 6 | Gmail integration | |
| 7 | Outlook / M365 integration | |
| 8 | AI layer | |
| 9 | Frontend dashboard | |
| 10 | Testing: unit, integration, E2E, load, security | |
| 11 | Deployment: Docker, CI/CD, Terraform, observability | |

Each phase lands complete, documented and tested before the next begins.
