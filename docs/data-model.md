# Data model

Source of truth: [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma).
This document explains the decisions behind it — the schema itself carries the details.

---

## Conventions

**Every tenant-scoped table carries `userId`, first in every composite index.**
There are no cross-user joins anywhere in the application. That constraint is what makes
sharding by `userId` a deployment change rather than a rewrite when a single primary runs out
(architecture §9).

**Encrypted columns come in threes.** A ciphertext column is always accompanied by its wrapped
data key and a key version (ADR 0002):

```
bodyTextCipher  Bytes     bodyDek  Bytes     bodyKeyVersion  Int
```

They are never indexed. A database-level `CHECK` rejects a row carrying ciphertext without its
key — an undecryptable row is worse than a rejected write, because you find it during an
incident rather than at insert time.

**Provider identifiers are unique per account, never globally.** Gmail and Graph both reuse ids
across mailboxes, so every constraint is `(accountId, providerMessageId)`.

**Table names are snake_case, model names are PascalCase.** The schema carries explicit
`@map` on every column because this system runs a substantial amount of raw SQL — RLS
policies, partial indexes, retention sweeps, analytics — and quoting `"createdAt"` throughout
all of it is a permanent tax.

---

## Table groups

### Tenancy — `organizations`, `org_memberships`, `teams`, `invitations`

Organizations exist for billing, administration and policy (`enforceTwoFactor`,
`allowedEmailDomains`). They are _not_ a shared-inbox boundary: mail belongs to a user, never to
an org, so an admin cannot read a colleague's email. Teams are a grouping inside an org for
future permission scoping.

Invitations store `tokenHash` (SHA-256), never the token. The token is shown once.

### Users and auth — `users`, `sessions`, `api_keys`

`phoneNumber` is globally unique. Two accounts cannot share a WhatsApp number, because the
number _is_ the routing key for inbound messages — an ambiguity there would deliver one
person's mail to another's chat.

`tokensValidFrom` is the global revocation lever: bumping it invalidates every access token
issued before that moment without a token blacklist.

`sessions` implements **refresh-token rotation with theft detection**. Each row stores the hash
of one refresh token and a `familyId`. Presenting a token that has already been rotated means
it was stolen, so the entire family is revoked rather than just the one token.

TOTP secrets and recovery codes are encrypted and hashed respectively. `failedLoginAttempts` +
`lockedUntil` back progressive lockout.

### Mailboxes — `email_accounts`

Holds the OAuth grant, envelope-encrypted. **No password column exists anywhere in this
schema**, for any provider — the schema itself enforces the "never store passwords" rule.

Sync state lives here too: `syncCursor` (Gmail `historyId`, Graph `deltaLink`, IMAP `UIDNEXT`),
`watchSubscriptionId`, `watchExpiresAt`. The `(status, watchExpiresAt)` index drives the
renewal sweep; `pollingSince` records that push has failed and we have fallen back to polling,
so degraded accounts are visible rather than silently quiet.

`consecutiveFailures` drives back-off, and `status = reauth_required` is the state that prompts
the user to reconnect.

### Mail — `email_threads`, `email_messages`, `attachments`

`email_messages` is the largest table by far and is designed for it:

- `(accountId, providerMessageId)` unique — **the idempotency guarantee for ingest**. Providers
  retry webhooks aggressively; this constraint is what turns a triple-delivered notification
  into one row.
- `messageIdHeader`, `inReplyTo`, `references` are stored verbatim. These three columns are the
  entire basis of invisible threading (ADR 0003), so they are never normalized or rewritten.
- `snippet` is stored in clear while bodies are encrypted. The snippet has already been sent to
  the user's phone in a WhatsApp notification; encrypting it would protect nothing while
  costing a decrypt on every list query.
- `contentHash` (SHA-256 of normalized subject + body) is what lets 10 000 users who received
  the same newsletter share one AI analysis instead of paying for 10 000.
- `bodyPurgedAt` records retention deletion, so the UI can say "this body has expired" rather
  than 404.

Attachment bytes live in object storage under a `userId`-prefixed key; the row records
`storageKey`, `contentHash` and scan results. Bytes are fetched lazily — ingest never pulls a
50 MB file to deliver a notification.

Partitioning `email_messages` by month is the next scaling step; the schema is ready for it
(no foreign keys point at it from outside the user's own data) and it is deliberately deferred
until volume justifies the operational cost.

### AI output — `message_analyses`, `message_embeddings`

One analysis row per message, written by a single structured LLM call. `entities` and
`actionItems` are JSON because they are always read whole and never queried by inner field.

`containsInstructionLikeText` flags a message whose body appears to be addressing an automated
assistant. It is shown to the user as a warning and never acted on (ADR 0004).

`message_embeddings` holds a `vector(1536)` with an **HNSW index over cosine distance** —
chosen over IVFFlat because it needs no training step, which matters for a corpus that grows
continuously rather than being loaded once.

### WhatsApp — `whatsapp_deliveries`, `whatsapp_inbound_messages`, `conversation_states`

`whatsappMessageId` (Meta's `wamid`) is unique on both tables. On the outbound side it is the
link a user's native reply resolves through — rank 1 on the thread-resolution ladder. On the
inbound side it is the webhook de-duplication key.

`wasTemplate` records that a message had to be sent as a billable template because the 24-hour
customer service window had closed, which is what makes template spend measurable.

`conversation_states` is the durable copy of per-user chat state. Redis holds the hot copy;
this exists so a Redis flush does not strand someone mid-reply. `lastInboundAt` is the field
the entire session-window decision hangs off.

### Sending — `drafts`

A draft carries its threading headers **frozen at compose time**. Recomputing them at send time
would risk drift if the thread moved underneath, and a wrong `References` header visibly
detaches the reply in the recipient's client.

`idempotencyKey` is unique. It is what guarantees a retried send job produces one email rather
than two — the failure mode a user would notice most.

### Preferences and memory — `user_preferences`, `ai_memory`, `contacts`

Preferences are _declared_; AI memory is _derived_. They are separate tables so that clearing
what the assistant has learned does not reset a user's settings.

`contacts` is a derived address book that powers "reply to Sarah" resolution (ladder rank 4)
and the most-contacted analytics. `aliases` holds the names a user actually uses in WhatsApp.

### Automations — `automation_rules`, `automation_runs`, `reminders`

Rules store conditions and actions as JSON validated by a Zod schema before persistence, and
are evaluated by an interpreter. **Nothing here is ever `eval`'d.** Actions that send mail are
restricted to the original sender and require user-authored text (ADR 0004).

`automation_runs` records every evaluation including non-matches, so a user asking "why didn't
my rule fire?" gets an answer.

### Billing — `subscriptions`, `ai_usage_records`

Plan limits are denormalized onto `subscriptions` so enforcement never joins to a plans table
on a hot path.

`ai_usage_records` aggregates by `(user, day, task, provider, model)` rather than storing a row
per call. At 50 M emails/day, per-call rows are write amplification for no analytical gain. The
budget check reads this before a call is made, not after the bill arrives.

### Audit — `audit_logs`, `processed_webhooks`

`audit_logs` is append-only, enforced twice: the application role holds `INSERT` and `SELECT`
only, and a trigger raises on `UPDATE`/`DELETE`. An audit log the audited code can rewrite is
not an audit log. `metadata` is redacted before write and never contains bodies, tokens or full
addresses.

`processed_webhooks` is the idempotency ledger for provider events, swept on `expiresAt`.

---

## Row-level security

Every tenant-scoped table has RLS enabled and forced:

```sql
CREATE POLICY tenant_isolation ON email_messages
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
```

The application sets the context per transaction:

```ts
await withTenant(prisma, userId, async (tx) => {
  return tx.emailMessage.findMany(); // implicitly scoped
});
```

`SET LOCAL` is deliberate: the setting dies with the transaction, so a pooled connection cannot
carry one user's context into the next request. `withTenant` validates that `userId` is a UUID
before interpolating it, because `SET LOCAL` accepts no bind parameters — the validation _is_
the injection defence, and the two must never be separated.

### The failure mode this nearly had

**Postgres exempts superusers and `BYPASSRLS` roles from every policy.** An application
connected as the database owner has RLS silently disabled: the policies exist, `\d` shows them,
and nothing is enforced. This was observed during development — the isolation tests passed
vacuously until the connection was switched to the restricted role.

Two things prevent it recurring:

1. `assertTenantIsolationEnforceable()` runs at boot and refuses to start when the connection
   role is a superuser or holds `BYPASSRLS`.
2. The integration tests require `TEST_DATABASE_URL` to use `wea_app`, and one of them asserts
   the boot check passes — so a regression fails CI rather than production.

Work that legitimately spans users (retention sweep, watch renewal, admin console) goes through
`withoutTenantScope(client, reason, fn)` with a `reason` drawn from a closed enum. Adding a
member to that enum is a deliberate, reviewable act.

---

## Retention and erasure

| Data                             | Default         | Configurable |
| -------------------------------- | --------------- | ------------ |
| Message bodies (encrypted)       | 30 days         | per user     |
| Attachments                      | 30 days         | per plan     |
| Message metadata                 | Life of account | —            |
| Audit logs                       | 365 days        | per org      |
| `whatsapp_inbound_messages.body` | 7 days          | —            |
| `processed_webhooks`             | 24 hours        | —            |

Every foreign key from user data cascades on delete. **GDPR erasure is
`DELETE FROM users WHERE id = $1`** plus an object-storage prefix sweep — nothing is left
orphaned, because the schema was built so that nothing _can_ be.

---

## Migrations

```
packages/db/prisma/migrations/
  20260804000000_init/          generated from the schema
  20260804000100_hardening/     hand-written: what Prisma cannot express
```

The hardening migration carries the HNSW vector index, trigram and full-text indexes, partial
indexes for the hot paths, the append-only audit trigger, all RLS policies, the least-privilege
`wea_app` role, and the encryption-pairing `CHECK` constraints. It is idempotent and safe to
re-run.
