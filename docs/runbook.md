# Runbook

What to do when something is wrong, written against the alerts and metrics that
actually exist. Every query here can be pasted into Prometheus as-is, and every
metric named is one this system exports — `infra/k8s/monitoring/alerts.yaml` is
the source of truth and this is the prose that goes with it.

Two things to know before anything else.

**The system's characteristic failure is silence, not an error.** A webhook is
answered with 200 before the work is queued, because Meta redelivers anything
slower than five seconds and a redelivered message is a duplicate reply. So a
broken queue, a broken consumer and a broken provider all look identical from
outside: messages arrive, nothing happens, nobody is told. Three separate bugs
with exactly that signature have been found here by running the product; see
`docs/status.md`. When a user reports "it stopped working", assume the pipeline
accepted the work and dropped it, and start at the queue.

**Outbound mail is real in every environment.** There is no capture, no
sandbox. Replies go through the user's own OAuth grant to whoever the original
was from. Nothing in this runbook should be tested by sending mail from a
production account.

---

## Is it broken, and where

Four questions, in order. Each one rules out a layer.

```promql
# 1. Is anything running?
wea_api_up
wea_worker_up

# 2. Is work arriving?
sum(rate(wea_http_requests_total{route="/webhooks/whatsapp"}[5m]))

# 3. Is it being done?
sum by (queue) (rate(wea_jobs_total{outcome="completed"}[5m]))

# 4. Is it failing?
sum by (queue, job) (rate(wea_jobs_total{outcome="failed"}[5m]))
```

If 2 is zero, the problem is upstream of this system — Meta is not delivering,
which usually means the webhook subscription or the tunnel, not the code. If 2
is non-zero and 3 is zero, the work is reaching Redis and no consumer is taking
it. If 3 and 4 are both non-zero, the pipeline is running and something inside a
handler is wrong.

`wea_queue_depth` tells you a backlog exists. It cannot tell you which of the
three causes it is — arrival rate, slowness, or failure — and they want
different responses, so read it alongside the rates above rather than alone.

---

## Alerts

### WeaApiDown / WeaWorkerDown

Zero replicas available. Check `kubectl get pods -n wea` first: a pod stuck in
`CreateContainerConfigError` is almost always a missing key in `wea-secrets`,
and the pod events name it.

The API refuses to start on a variable that is missing or malformed, and says
which — that failure is loud and the message is the fix. `WeaCrashLooping` fires
alongside if it is restarting rather than absent.

### WeaWorkerNotReady

Replicas exist but `/health/ready` is failing. It checks the database and Redis
with a three-second deadline and returns 503 when either is down, so this is
almost always a dependency rather than the worker. Confirm with
`kubectl exec` into a pod and hitting `:3002/health/ready` — the response body
names which check failed.

A worker that is unready stops consuming. Expect `WeaQueueStuck` behind this.

### WeaWebhookFailing

The API is returning 5xx to Meta or Google. This is the alert that matters most,
because a 5xx to Meta means redelivery and a 200 means the message is gone
forever — so a webhook failing loudly is recoverable and one failing quietly is
not.

```promql
sum by (status) (rate(wea_http_requests_total{route=~"/webhooks/.*"}[5m]))
```

Check the API logs for `whatsapp.webhook.enqueue_failed`. If Redis is the cause,
fix Redis; Meta retries for up to several hours and the backlog will drain.

### WeaCommandBacklog / WeaSendBacklog

Depth over threshold. Commands are what a user is waiting on — a reply that
takes two minutes reads as broken — and sends are replies the user has already
confirmed.

KEDA scales the worker on `bull:commands:wait` and `bull:notify:wait` between 2
and 20 replicas. If depth is high and replicas are at minimum, KEDA is not
seeing the queue: its trigger reads BullMQ's own key layout (`bull:<queue>:wait`)
and a customised prefix would make it read an empty list forever, scaling
nothing while reporting healthy.

Nothing is lost while a backlog drains. The draft claim makes each send happen
exactly once whenever it runs.

### WeaQueueStuck

Depth non-zero and unchanged for fifteen minutes. A deep queue that is shrinking
is a busy system; one that has not moved has no consumer. Check worker readiness
first.

### WeaJobFailureRate

More than one job in ten failing on a queue. Counted per attempt, so retries of
one bad job inflate it — which is the point, since four attempts is four times
the provider load.

```promql
sum by (queue, job) (rate(wea_jobs_total{outcome="failed"}[10m]))
```

Then read the `job.failed` log lines for that queue. The `code` field is the
diagnosis:

| `code`                   | Meaning                           | What to do                                                    |
| ------------------------ | --------------------------------- | ------------------------------------------------------------- |
| `PROVIDER_UNAUTHORIZED`  | The user's OAuth grant is gone    | Nothing operational — the user is prompted to reconnect       |
| `PROVIDER_RATE_LIMITED`  | Gmail or Graph is throttling      | Retries handle it; if sustained, the account is over quota    |
| `DEPENDENCY_UNAVAILABLE` | A third party is down             | Wait; retries are what this code exists for                   |
| `ENCRYPTION_FAILURE`     | A key problem, not a data problem | See **Encryption failures** below — do not retry blindly      |
| `BAD_REQUEST`            | A malformed payload               | Non-retryable by design; the job is discarded, the DLQ has it |

### WeaJobsDeadLettered

Work the system accepted, retried to exhaustion, and will not do. Each one is a
message, an email or a reply someone is missing.

Payloads are kept — `removeOnFailCount` is 10 000 per queue — so they are
replayable once the cause is fixed. Read the failures before replaying. The
failed set holds ids; the reason and the payload are on the job hash:

```sh
# Failed job ids on a queue, most recent first
redis-cli ZREVRANGE bull:commands:failed 0 20

# Why one of them failed, and what it was carrying
redis-cli HGET "bull:commands:<job-id>" failedReason
redis-cli HGET "bull:commands:<job-id>" data
```

Ids are built by `jobKey()` and look like `wa~wamid.HBgL…` or
`poll~<account-id>~<history-id>` — a colon in one is impossible, because BullMQ
rejects it and every id in this codebase used to contain one.

Replay by re-enqueuing with a **new** id. The original is a deduplication key
and BullMQ drops a re-add under the same one, which looks exactly like a replay
that worked.

### WeaJobsSlow

p95 job duration above a minute. Not itself a failure — an LLM call or a large
mailbox sync is legitimately slow. It matters because concurrency is fixed
(`QUEUE_DEFAULTS`), so duration and throughput trade directly: at this p95 the
queue drains slower than it fills.

```promql
histogram_quantile(0.95, sum by (le, queue, job) (rate(wea_job_duration_seconds_bucket[10m])))
```

Adding `job` to the grouping is usually enough to name the culprit.

### WeaApiErrorRate / WeaApiLatency

5xx rate or p95 latency over threshold. Group by route:

```promql
topk(5, sum by (route, status) (rate(wea_http_requests_total{status=~"5.."}[5m])))
histogram_quantile(0.95, sum by (le, route) (rate(wea_http_request_duration_seconds_bucket[5m])))
```

A slow OAuth callback is usually Google, not this system. A slow webhook route
is the one to care about: it is the path with a five-second budget.

### WeaMetricsMissing / WeaApiMetricsMissing

The alert about the alerts. Every rule above goes quiet when the scrape stops,
and silence from a monitoring system is indistinguishable from good news. Check
the ServiceMonitor and the pod's `/metrics` directly.

Note that the worker's Service is deliberately headless. A balanced Service
would hand the scraper a different pod's counter each interval and `rate()`
would read the difference as a reset, reporting near-zero throughput on a busy
system.

### WeaMigrationFailed

The migration Job did not complete. Nothing else should be rolled out until it
does — the Deployments assume the schema they were built against.

It connects as the owner role; the application connects as `wea_app`, which
cannot bypass row-level security or alter a table. If the migration succeeds and
the app then fails on permissions, the grants in the migration are what to look
at, not the connection string.

### WeaOomKilled

A container hit its memory limit. The likely culprits are attachment handling
and embedding batches — both are bounded in code (`MAX_STORED_BODY_BYTES`, the
media pipeline's per-file jobs), so a genuine OOM is worth investigating rather
than raising the limit reflexively.

---

## Situations the alerts do not cover

### A user says replies are not arriving

The send returned 200 and Meta reported the failure afterwards. That receipt is
the only thing that knows:

```sql
SET app.current_user_id = '<user-id>';
SELECT whatsapp_message_id, kind, status, error_code, error_message, created_at
FROM whatsapp_deliveries
WHERE user_id = '<user-id>'
ORDER BY created_at DESC
LIMIT 20;
```

| `error_code` | Meaning                            |
| ------------ | ---------------------------------- |
| 131047       | The 24-hour window has closed      |
| 131026       | The number cannot receive messages |
| 470          | The template is not approved       |

A closed window is not a fault. Mail is deferred and delivered as a digest the
moment the user texts, which is what `notify.retryDelivery` and the digest sweep
exist for.

`status = 'sent'` with no `delivered_at` and no `failed_at` means no receipt ever
arrived — check that the app is subscribed to the `messages` webhook field,
which carries statuses as well as messages.

### A user says nothing arrives at all

Check, in order:

1. `SELECT phone_verified FROM users WHERE ...` — an unverified number reads as
   no number at all.
2. `SELECT status, consecutive_failures FROM email_accounts WHERE ...` — an
   account in `reauth_required` has been disconnected by the provider.
3. Whether the mailbox is on push or polling. No Pub/Sub topic means polling,
   and mail arrives within the poll interval rather than in seconds. That is a
   supported way to run, not a fault.

### Encryption failures

`ENCRYPTION_FAILURE` is deliberately indistinguishable between a wrong key, a
tampered ciphertext and mismatched AAD — the error does not say which, because
saying which is an oracle. Operationally that means the cause has to come from
context rather than from the message:

- **All users at once, right after a deploy** — `KMS_PROVIDER` or `KMS_KEY_ID`
  changed. The provider refuses rather than falling back, which is the intended
  behaviour: a fallback would run the system on a static key while the operator
  believed the KEK was in KMS.
- **One user, one field** — that record's data key cannot be unwrapped. Rotation
  does not cause this; the envelope layer keeps a key version per record for
  exactly that reason.
- **Everything, on a machine that was working** — check that the KMS grant still
  exists and that the role has `kms:Decrypt`.

### The queue is full of work nobody wants

A deploy that changed a job name leaves the old name enqueued with no handler,
and the processor's `default:` throws as non-retryable — so they dead-letter
immediately rather than looping. Drain them:

```
redis-cli DEL bull:<queue>:failed
```

This has happened once for real: `notify.retryDelivery` was enqueued for months
with no case in the switch, and every WhatsApp delivery receipt was discarded.
If a job name appears in `wea_jobs_total{outcome="dead_lettered"}` with no
matching `completed`, that is the shape.

---

## Routine operations

### Deploying

The migration Job runs first and the Deployments wait on it. A migration that
adds a column is safe with the old code running; one that removes or renames is
not, and needs the two-step — deploy the code that stops using it, then the
migration.

### Rotating the WhatsApp token

A 24-hour token expires overnight and every send fails with 401 the next
morning. Use a System User token. Rotating it is a change to `wea-secrets`;
External Secrets picks it up within its refresh interval, and the pods read it
at boot, so a restart is needed.

### Rotating the KMS key

Nothing to do. KMS rotates the backing material on its own schedule and every
ciphertext blob names the material that produced it. The envelope layer's
`keyVersion` exists for the local provider, which has no such property.

### Checking a deployment before it serves traffic

`pnpm preflight` calls the real services — Meta, Google, the model provider —
performs Meta's webhook handshake against the configured endpoint, and prints
what to change. It is read-only and safe against production. It catches the
class of problem the boot check cannot: a variable that is well-formed and
wrong.

---

## Verifying the pipeline without touching production

`tools/local-loop/` stands up the whole path with only the Cloud API replaced by
a stub on localhost — real API, real worker, real Redis, real Postgres, real
row-level security. Its README is the procedure. It is the fastest way to
confirm a change to the inbound path, the command parser or the send path works
at all, and it is how the three silent-failure bugs in `docs/status.md` were
found.
