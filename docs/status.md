# Build status

Honest accounting of what exists, what is verified, and what remains.

Last updated: 2026-08-04.

---

## Verified working

Everything below has tests that run and pass. **336 tests** (328 unit + 8 integration),
lint and typecheck clean across every package.

| Package         | Tests           | What it does                                                                                                    |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `@wea/shared`   | 40              | Env contract, domain types, queue definitions, log redaction, action-payload codec, phone normalization         |
| `@wea/crypto`   | 74              | Envelope encryption (AES-256-GCM + KMS), Argon2id, token hashing, webhook signature verification, blind indexes |
| `@wea/db`       | 8 (integration) | Prisma schema, two migrations, seed. RLS verified against real Postgres 16 + pgvector                           |
| `@wea/whatsapp` | 115             | Session window, delivery policy, webhook parsing, message builders, Cloud API client, command parser            |
| `@wea/mail`     | 99              | Threading headers, MIME composition, Gmail message normalizer, provider port                                    |

```bash
pnpm -r test          # 328 unit tests
pnpm --filter @wea/db test:integration   # needs TEST_DATABASE_URL on the wea_app role
```

### Verified against real infrastructure

- Both migrations apply to PostgreSQL 16 with pgvector; the seed is idempotent.
- Row-level security isolates tenants: no context → no rows; scoped → own rows only;
  cross-tenant read → empty; cross-tenant write → refused by policy.
- `audit_logs` rejects UPDATE and DELETE at both the grant and trigger level.
- Encryption-pairing CHECK constraints reject ciphertext stored without its wrapped key.
- HNSW, trigram and partial indexes are created.

---

## Not yet built

Listed plainly, because a half-wired OAuth flow is worse than an absent one.

### Next, in order

1. **`apps/api`** — NestJS: config bootstrap, structured logging with redaction, health
   checks, error filter, rate limiting, auth module (JWT with refresh rotation, TOTP 2FA,
   RBAC), webhook controllers that verify and enqueue.
2. **`apps/worker`** — BullMQ processors wiring the pipeline the architecture describes:
   ingest → analyze → notify, plus send, sync and automations.
3. **Gmail API client** — OAuth flow, `users.watch` + Pub/Sub, history sync, threaded send.
   The normalizer and MIME composer it depends on are done and tested.
4. **`@wea/ai`** — provider abstraction, the single structured analysis call, embeddings,
   budgets, and the prompt-injection envelope from ADR 0004.
5. **Thread resolution service** — the confidence ladder from ADR 0003. Ranks 1 and 2 (the
   `context.id` and button-payload signals) are already parsed and tested; ranks 3–5 need
   the conversation-state store and the disambiguation flow wired.

### After that

- Microsoft Graph adapter (Phase 7)
- Next.js dashboard (Phase 9)
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

---

## Findings worth carrying forward

Four things surfaced during the build that would have been expensive to discover later.

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
