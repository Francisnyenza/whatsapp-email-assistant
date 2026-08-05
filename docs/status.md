# Build status

Honest accounting of what exists, what is verified, and what remains.

Last updated: 2026-08-04.

---

## Verified working

Everything below has tests that run and pass. **446 tests** (408 unit + 38 integration against
real Postgres), lint and typecheck clean across every package and app.

| Package         | Tests           | What it does                                                                                                    |
| --------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `@wea/shared`   | 40              | Env contract, domain types, queue definitions, log redaction, action-payload codec, phone normalization         |
| `@wea/crypto`   | 74              | Envelope encryption (AES-256-GCM + KMS), Argon2id, token hashing, webhook signature verification, blind indexes |
| `@wea/db`       | 8 (integration) | Prisma schema, two migrations, seed. RLS verified against real Postgres 16 + pgvector                           |
| `@wea/whatsapp` | 115             | Session window, delivery policy, webhook parsing, message builders, Cloud API client, command parser            |
| `@wea/mail`     | 115             | Threading, MIME composition, Gmail normalizer + provider, OAuth, error classification                           |
| `apps/api`      | 17              | Webhook ingress with signature verification, health, config, error handling, DI metadata                        |
| `apps/worker`   | 47 + 38 (int.)  | Resolution ladder, response planner, outbound sender, send pipeline with at-most-once claim, token decryption   |

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

1. **Acting on a confirmation tap.** The loop asks correctly and records the pending
   action, but tapping "Delete" or "Send" does not yet execute anything — the handler for
   an inbound `confirm_*` payload is the missing piece, and it needs the Gmail client
   below to have anywhere to send.
2. **Auth module** — JWT with refresh rotation and theft detection, TOTP 2FA, RBAC. The
   schema and crypto for all of it exist; the endpoints do not.
3. **The ingest processor** — Gmail push → fetch → persist → notify. This is the "email
   arrives on WhatsApp" half; `GmailProvider.fetchChanges` and the notification builder are
   both done, so what's missing is the handler joining them.
4. **OAuth connect endpoints** — `GmailProvider.authorizationUrl` and `exchangeCode` are
   written and typed against the real client; the API routes that drive them are not. Until
   these exist there is no way to connect a mailbox, so nothing runs end to end.
5. **Draft body encryption on the send path.** `DraftRepository` stores the ciphertext
   columns, but `claimForSending` returns the plaintext its caller passes rather than
   decrypting — the wiring to `AccountService`'s crypto is the gap.
6. **`@wea/ai`** — provider abstraction, the single structured analysis call, embeddings,
   budgets, and the prompt-injection envelope from ADR 0004.

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

**`eslint --fix` can break NestJS dependency injection.** The
`consistent-type-imports` rule rewrote all six injected classes to `import type`, which
erases the runtime binding `emitDecoratorMetadata` needs. Typecheck passed, unit tests
passed, and it would have failed at boot in production. The rule is off for the DI layers,
and `apps/api/test/di.spec.ts` asserts `design:paramtypes` survives — running against
`dist/`, because vitest transpiles with esbuild, which does not implement
`emitDecoratorMetadata` at all.

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
7. **A reply is sent at most once.** The draft claim is a conditional write, so two
   workers racing on one draft means exactly one send. Tested with genuinely concurrent
   claims against Postgres, not two calls to a mock.
8. **Webhooks verify before parsing and acknowledge before working.** Missing raw bytes
   fail closed; an authentic payload always gets a 200 so a bug here cannot trigger
   endless redelivery.
