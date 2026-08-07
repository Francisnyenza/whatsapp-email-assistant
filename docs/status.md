# Build status

Honest accounting of what exists, what is verified, and what remains.

Last updated: 2026-08-06.

---

## Verified working

Everything below has tests that run and pass. **765 tests** (598 unit + 167 integration against
real Postgres), lint and typecheck clean across every package and app.

| Package         | Tests            | What it does                                                                                                 |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `@wea/shared`   | 40               | Env contract, domain types, queue definitions, log redaction, action-payload codec, phone normalization      |
| `@wea/crypto`   | 104              | Envelope encryption (AES-256-GCM + KMS), Argon2id, TOTP (RFC 6238), token hashing, signatures, blind indexes |
| `@wea/db`       | 8 (integration)  | Prisma schema, seven migrations, seed. RLS verified against real Postgres 16 + pgvector                      |
| `@wea/whatsapp` | 115              | Session window, delivery policy, webhook parsing, message builders, Cloud API client, command parser         |
| `@wea/mail`     | 130              | Threading, forwarding, MIME composition, Gmail normalizer + provider, OAuth, error classification            |
| `apps/api`      | 64 + 38 (int.)   | Auth with refresh rotation and TOTP 2FA, WhatsApp + Gmail webhook ingress, OAuth connect, health, errors     |
| `apps/worker`   | 118 + 115 (int.) | Ingest, notify, resolution ladder, planner, mailbox actions, reply + forward, send, watch renewal, retention |

```bash
pnpm -r test          # 598 unit tests
pnpm --filter @wea/db test:integration   # needs TEST_DATABASE_URL on the wea_app role
```

### Verified against real infrastructure

- All seven migrations apply to PostgreSQL 16 with pgvector; the seed is idempotent.
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

---

## Not yet built

Listed plainly, because a half-wired OAuth flow is worse than an absent one.

### Next, in order

1. **The digest.** With templates in place, high-priority mail now reaches a user outside
   the messaging window — but ordinary mail is deferred to a digest, and nothing consumes
   `notify.digest`. So that mail is still not delivered; it is merely deferred correctly
   now instead of dropped silently. This is the other half of the window problem and the
   next thing to build.
2. **The AI layer.** Notifications deliver without a summary today, which is by design —
   but the card is noticeably thinner than the product intends.
3. **The polling fallback.** `pollingSince` is written when a watch cannot be established
   or renewed, and the renewal sweep now retries those accounts every hour — but nothing
   yet polls on their behalf in the meantime. An account in that state receives nothing
   until a watch succeeds.
4. **`@wea/ai`** — provider abstraction, the single structured analysis call, embeddings,
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

Things that surfaced during the build and would have been expensive to discover later.

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
11. **Webhooks verify before parsing and acknowledge before working.** Both the WhatsApp
    and Gmail endpoints reject unauthenticated requests before touching the payload, respond
    before doing work, and always return 2xx once authentic — so a bug on our side cannot
    make a provider redeliver forever. Missing raw bytes
    fail closed; an authentic payload always gets a 200 so a bug here cannot trigger
    endless redelivery.
