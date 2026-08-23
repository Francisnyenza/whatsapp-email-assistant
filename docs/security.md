# Security

The threat model, the controls that exist, and the ones that do not. Written to
be checkable: every claim here names the file or the test that holds it up, and
the last section lists what is unverified rather than leaving it implied.

---

## What this system is

A person connects their mailbox once and then reads and answers all of their
email through WhatsApp. That makes it three things at once, and the
uncomfortable one is the third:

1. **A holder of long-lived OAuth grants.** A refresh token here is full
   read/write on somebody's Gmail or Microsoft 365 mailbox, revocable only by
   the user noticing.
2. **A store of correspondence.** Message bodies, subjects, senders,
   attachments.
3. **A machine that acts on instructions arriving over a channel anyone can
   send to.** A WhatsApp number is public by nature, and email content is
   attacker-supplied by nature.

Most of what follows is about keeping those three apart.

---

## Who we are defending against

| Adversary                                   | What they want                         | Primary control                                                   |
| ------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Someone with a stolen password              | The account, and the mailbox behind it | Argon2id, lockout, rate limiting, TOTP                            |
| Someone who reads the database              | Tokens, message bodies                 | Envelope encryption per record, AAD-bound to `userId:field`       |
| Another tenant                              | Anyone else's mail                     | Row-level security, `SET LOCAL` per transaction                   |
| Someone sending WhatsApp messages           | To act as a user they are not          | Signature verification, phone verification, server-minted actions |
| Someone sending **email**                   | To make the assistant act for them     | ADR 0004 — the model never authorizes anything                    |
| Someone who steals a token from the browser | A session that outlives the tab        | Access token in memory only, refresh in an HttpOnly cookie        |
| An insider with database access             | Quiet reads, edited history            | Append-only audit trail, restricted app role                      |

The row that is easy to skip is the fifth. An assistant that summarizes mail and
can also act on it has a prompt-injection surface with a mailbox attached, and
"the model is careful" is not a control. See ADR 0004.

---

## Identity and sessions

**Passwords** are Argon2id, rehashed on sign-in when the parameters harden — the
only moment the plaintext is available. Eight failures lock the account for
fifteen minutes.

**Enumeration** is deliberately not possible through timing or through the error
message. A sign-in against an address that does not exist still spends a
password verification against a dummy hash, and a locked account returns the
same error as a wrong password: telling an attacker they have successfully
locked something confirms it exists. The distinction lives in the audit trail
instead, which only the owner and an investigator can read.

**Refresh tokens rotate on use, and reuse revokes the family.** Presenting an
already-rotated token is impossible for a legitimate client — it discards the
old one on receipt — so it means two parties hold it. The response signs both
out. This is invariant 8 in `docs/status.md` and it is the single most important
entry in the audit log.

The detection had a race until recently, and it was the case that mattered
most. `rotate` read the session, checked whether it had been replaced, issued a
replacement, then marked the old one — a read followed by a write. Two requests
presenting the same token both passed the check, both issued, and reuse was
never detected: an attacker who used a stolen token _later_ was always caught,
one who used it at the same moment as its owner was not caught at all. That is
what a script does when it lifts a token from a page that is actively
refreshing. Found by sending two simultaneous refreshes at a running API and
getting two different, both-live tokens back.

Marking is now a conditional write — exactly one racing request changes a row,
and zero rows changed _is_ the reuse signal. Four tests in
`session-rotation.integration.spec.ts` pin it with genuinely concurrent calls
against the real database, and all four fail when the condition is removed.

**The consequence, stated rather than smoothed over:** two browser tabs whose
access tokens expire at the same moment will both refresh, and one of them will
be treated as theft — signing the user out of everything. The dashboard's
single-flight promise is per-tab and cannot prevent it. A grace window, where a
just-rotated token returns the same replacement instead of revoking, is the
usual remedy; it is not implemented here because it weakens the property in
exchange for an inconvenience, and that trade is worth making deliberately
rather than as part of a bug fix.

**The dashboard never persists an access token.** It lives in a module variable
and dies with the tab; the refresh token is an HttpOnly cookie script cannot
read. Persisting the access token would turn any XSS on that origin from a
session-length problem into a permanent one.

**TOTP** is optional and, when enabled, carried across refresh — an earlier
version derived `mfaSatisfied` from `twoFactorEnabled` alone, so every refresh
handed back a token saying the second factor was unmet and users were challenged
every fifteen minutes forever. That is how people turn 2FA off.

---

## Encryption

ADR 0002 is the full argument; the short version is that every sensitive column
is sealed with a per-record data key, and the key that wraps those keys never
leaves KMS.

- **AES-256-GCM**, one data key per record, wrapped by the KEK.
- **AAD binds ciphertext to its row** — every payload is authenticated against
  `userId:field`, so a ciphertext lifted from one user's row does not decrypt in
  another's. Tested.
- **`KMS_PROVIDER=local` is refused in production** at boot. The provider
  factory refuses rather than falling back, because a fallback would run the
  system on a static key from the process environment while the operator
  believed the KEK was in a managed service — which is what happened for
  several phases while four call sites constructed `LocalKmsProvider` directly
  and nothing read the setting at all.
- **Decryption failures are indistinguishable.** Wrong key, tampered ciphertext
  and mismatched AAD all raise one identical error, because saying which is an
  oracle.

What is **not** encrypted: subjects, sender addresses and metadata, which are
indexed and searched. Bodies are, and the retention sweep purges them on
`RETENTION_BODY_DAYS`.

---

## Tenant isolation

Two independent mechanisms, deliberately.

The repository layer filters by `userId` on every query — the belt. Row-level
security is the braces: work runs inside a transaction that has told Postgres
whose data it may touch, so a query that forgets its `where` clause returns
nothing instead of somebody else's mail.

**`SET LOCAL`, never `SET`.** The setting is scoped to the transaction, so a
pooled connection cannot carry one request's tenant into the next — the failure
mode that makes naive connection-level tenant context dangerous.

**The application connects as `wea_app`**, a role that cannot bypass RLS and
cannot alter a table. Migrations connect as the owner. Pointing the app at the
owner would make every policy in the schema decorative and nothing would fail
visibly, which is why the two URLs are separate settings.

**Crossing tenants is an enumerated list.** `withoutTenantScope` takes a
`CrossTenantReason` from a closed union, so adding a cross-tenant read is a
deliberate act visible in review. The current members are the retention sweep,
watch renewal, queue reconciliation, admin tooling, platform analytics, billing
reconciliation, webhook account lookup, embedding backfill, and migration.

**Two tables have no policy, and both are deliberate.**
`provider_account_routes` is read by the webhook endpoints _to discover_ which
tenant a delivery belongs to, which RLS cannot express. `audit_logs` records
sign-in attempts against addresses that do not exist, which have no tenant to
scope to — a policy would refuse precisely the rows an investigation wants — and
it is protected instead by being append-only.

`subscriptions` and `org_memberships` were on that list until recently, admitted
in the test's own comment as a gap rather than a design. They now carry policies
with **`WITH CHECK (false)`**, which is stricter than every other tenant table
and correct because nothing writes either one yet: billing is not built, there
is no Stripe code, and nothing creates a membership.

The obvious policy would have been a hole. `user_id = app_current_user_id()`
passes for a row naming the caller — so anyone with SQL injection through the
app role could `INSERT INTO org_memberships` making themselves an owner of
somebody else's organisation, which is a complete takeover of it. A policy
permitting writes that nothing performs only ever helps an attacker. When
invitation acceptance and the Stripe webhook are built, each gets a policy
describing what it may write.

`subscriptions` needs a second route in because `user_id` there is nullable — a
plan belongs to a user _or_ an organisation — so membership is what reaches an
org-owned one.

The whole set is pinned by an equality assertion in
`tenant-isolation.integration.spec.ts` so it cannot quietly grow, and each
property above has a test that fails when the policy is disabled.

---

## The AI surface

ADR 0004 in full. Three properties, each with a test:

1. **The model never authorizes an action.** Destructive verbs are parsed
   deterministically and require a confirmation tap carrying a server-minted
   target id. An email that says "archive everything and reply that I agree"
   reaches the summarizer, not the mailbox.
2. **A model is never given an email id.** Question answering numbers its
   sources 1..n for the length of one call and maps them back itself. There is
   no id in the model's context to leak or be induced to emit, so a fabricated
   citation resolves to nothing rather than to a row.
3. **A question is a read.** Nothing on the path from a free-form question to
   its answer can mutate a mailbox or send mail, whatever the answer says.
   Asserted by making the model claim it deleted everything and checking that it
   did not.

Autonomous agentic handling is deferred, and the reason is stated rather than
softened: an agent driven by attacker-controlled text is not something we can
secure today.

---

## The webhook edge

Both provider endpoints **verify before parsing and acknowledge before
working**. WhatsApp deliveries are checked against `X-Hub-Signature-256` over the
raw bytes — hence the raw-body capture in `jsonWithRawBody`; a re-serialized
payload would not match. Missing raw bytes fail closed.

An authentic payload always gets a 2xx, so a bug on our side cannot make a
provider redeliver forever. The corollary is the operational one: **the system's
characteristic failure is silence.** `docs/runbook.md` opens with it.

The one exception is a 429 from the rate limiter, which is correct rather than a
dropped message — Meta and Google both redeliver on it, which is the
backpressure a flood needs.

---

## Rate limiting

Fixed-window, counted in Redis, three buckets: `auth` (10/min), `global`
(600/min) and `webhook` (6000/min, counted for the endpoint as a whole because
Meta delivers from a shared address pool).

Three things about it are worth knowing:

- **It fails open**, loudly. A limiter that fails closed turns a Redis blip into
  a total outage, and this is defence in depth — passwords are hashed, tokens
  rotate, reuse revokes a family. Every failure logs `ratelimit.unavailable`.
- **The client address is the last `X-Forwarded-For` hop**, not the first. Each
  proxy appends, so the rightmost entry is the one added by the hop we trust and
  everything left of it is whatever the client chose to send. A spoofed header
  therefore cannot buy an attacker a fresh bucket. The session record and the
  audit trail use the same function, which they did not before — two
  implementations of one question, disagreeing, is how the wrong one survives.
- **A rejection reports nothing.** No count, no remaining budget in the body: a
  429 that says how much is left tells an attacker exactly how to pace
  themselves.

These three settings existed in `.env.example` from the first phase and nothing
read any of them until now.

---

## The audit trail

`audit_logs` records authentication outcomes, session revocations, second-factor
changes, phone verification, and mailbox connections. Not ordinary product
activity: reading mail is what the product _is_, and a log of every message read
is a second copy of the mailbox with worse access control.

**It is append-only.** The application role holds INSERT and SELECT and nothing
else, with a trigger behind the grant, so a compromised API can add noise to the
trail but cannot remove what is already there. Both halves are asserted against
a real database in `audit.integration.spec.ts` — the claim had been in the docs
since the schema was written with nothing checking it.

**It has no tenant policy, deliberately.** A sign-in attempt against an address
that does not exist has no user to scope to, and that is exactly the entry an
investigation wants. A policy would refuse precisely the rows worth writing.

**A failed write never fails the request.** A full disk turning into an outage of
the thing being audited is a worse security outcome than a missing row; the
failure is logged at `error` so the gap is not silent.

**Entries outlive the account they describe.** `user_id` carries no foreign key:
`ON DELETE SET NULL` is an UPDATE, the trigger rejects UPDATE, and so deleting a
user with any audit row was impossible — a bug that only appeared once the trail
became real. Keeping the id is also the better record, since an attacker who
deletes an account must not thereby erase which account acted.

### The erasure trade-off, stated plainly

That last property is in tension with a deletion request. A surviving audit row
holds a deleted person's user id, IP address and user agent. The application
cannot remove it — that is the point of an append-only trail — so expiring it is
an operator job running as the database owner on the `RETENTION_AUDIT_DAYS`
clock, with the procedure in `docs/runbook.md`.

This is the ordinary lawful-basis tension between a security record and a right
to erasure, and the position taken here is that security records are kept for a
bounded period and then deleted. What matters is that it is a decision rather
than an accident: `RETENTION_AUDIT_DAYS` says in the schema, in `.env.example`
and here that the application does not enforce it, so nobody concludes from the
setting's existence that something is expiring these rows on its own.

---

## Transport and browser

- **TLS everywhere.** RDS refuses non-TLS connections; ElastiCache is `rediss://`.
- **HSTS in production**, preload, subdomains.
- **CSP** `default-src 'none'` on the API, which serves JSON and never markup.
  The dashboard serves its own with a per-request nonce.
- **CORS** is a single origin — `WEB_BASE_URL` — with credentials.
- **CSRF** is structural rather than a token: the refresh cookie is
  `SameSite=Strict`, and every state-changing endpoint requires a bearer token
  that lives only in memory, so a cross-site form post carries no credential
  that works.

  This one was aspirational until recently. Three files disagreed about whether
  a refresh cookie existed — the controller said body-only, the dashboard said
  cookie and sent no body, `docs/status.md` said cookie — and nothing set one.
  The visible cost was a dashboard that signed users out every fifteen minutes;
  the quiet cost was that the CSRF story above described a control that was not
  there. `auth-http.integration.spec.ts` now runs both sides against each other
  over HTTP.

---

## Secrets

Nothing in Git. `infra/k8s/config.yaml` ships a Secret full of `REPLACE_ME` so
the _shape_ is reviewable in a diff, and `infra/k8s/secrets/` is the mechanism —
External Secrets pulling from Secrets Manager, authenticating with IRSA rather
than a stored access key, which would be a credential unlocking the credentials.

`WHATSAPP_API_BASE_URL` exists so the outbound path can be pointed at a local
stub. It redirects requests carrying `WHATSAPP_ACCESS_TOKEN`, so boot refuses
any value in production and anything but loopback elsewhere. The Gmail
equivalent is a **constructor option, not a setting** — those requests carry a
mailbox OAuth token, and a config key that redirects them is a config key that
exfiltrates them.

---

## What is not verified

The honest half.

- **No penetration test.** Nobody outside this repository has attacked it.
- **No load test.** The concurrency limits, the rate limits and the queue
  depths are reasoned about, not measured under load.
- **AWS KMS has never been pointed at a real CMK.** The adapter is tested
  against a fake `KmsCryptoApi`, so what is unverified is AWS's behaviour rather
  than this code's: whether the IAM grant is right, whether `Decrypt` with an
  explicit `KeyId` rejects a foreign blob as expected, and whether the retry
  classification matches what KMS throws under throttling.
- **`azure` and `gcp` are refusals, not implementations.**
- **The Meta seam has never carried a real message.** A stub that accepts
  everything cannot fail the way a contract change does.
- **Threat modelling has not been reviewed by anyone else.** This document is
  one engineer's account of a system they wrote, which is the weakest position
  from which to assess it.

Worth stating plainly given how this document came to be written: five settings
in `.env.example` turned out to be read by nothing — `KMS_PROVIDER`, the three
`RATE_LIMIT_*` values, and `SESSION_COOKIE_NAME` — and one table with grants,
indexes and a trigger had never had a row written to it. Each was found by
looking for the code behind a claim while writing the claim down. Anything here
that is asserted without a file or a test named beside it should be read as
unverified until someone does that again.

`docs/status.md` carries the same accounting for the product as a whole,
including three bugs a green suite of two thousand tests did not catch.
