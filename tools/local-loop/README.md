# Running the loop locally

Everything the product does between "a message arrives" and "a reply is sent",
without an internet connection and without a Meta app.

The Cloud API is replaced by a stub on `127.0.0.1:4010`; nothing else is. A real
API process, a real worker, real Redis, real Postgres and real row-level
security are all in the path. What this proves is the seam the tests could not
reach — that a signed webhook is accepted, crosses the queue, is understood, and
produces a request Meta would recognise.

It exists because running the product found, in minutes, two bugs that ~2,000
tests agreed were not there. Both are written up in `docs/status.md`.

## Once

```sh
cp .env.example .env      # then fill in the values marked required
pnpm install && pnpm build
set -a && . ./.env && set +a
```

`WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` can be any strings
here — the stub does not check them, but the API checks the signature it makes
from the first one, which is the point.

Add the line that redirects outbound sends at the stub:

```sh
export WHATSAPP_API_BASE_URL=http://127.0.0.1:4010
```

Leave it unset in a real deployment — boot refuses it there, and refuses
anything but loopback anywhere else, because requests through it carry
`WHATSAPP_ACCESS_TOKEN`. Unset, the client defaults to
`https://graph.facebook.com/$WHATSAPP_API_VERSION`.

## Each run

```sh
python3 tools/local-loop/stub-meta.py &            # captures to meta-capture.jsonl
node apps/api/dist/main.js &
node apps/worker/dist/main.js &

psql "$DATABASE_URL" -v phone="'+15559990007'" -f tools/local-loop/seed.sql
```

The seed makes one verified user, one email, one outbound card to reply to, and
an open 24-hour messaging window. Its OAuth token bytes are deliberately fake,
so anything that reaches the mail provider stops at `ENCRYPTION_FAILURE` — that
is the fixture being a fixture, not a defect. Commands that need no mailbox
(`help`, and the confirmation prompts) go all the way through.

Then send yourself a message:

```sh
FROM=15559990007 tools/local-loop/send-webhook.sh "help"
tail -1 tools/local-loop/meta-capture.jsonl | python3 -m json.tool
```

The last line is the reply, in the exact shape it would have gone to Meta.

## Receipts

Meta answers a send with 200 and reports the outcome afterwards, so the
receipts are the only thing that says whether a message arrived:

```sh
FROM=15559990007 tools/local-loop/send-status.sh wamid.STUB.0001 delivered
FROM=15559990007 tools/local-loop/send-status.sh wamid.STUB.0001 read
FROM=15559990007 tools/local-loop/send-status.sh wamid.STUB.0002 failed \
  131047 "Re-engagement message" "outside the 24 hour window"
```

Each lands in `whatsapp_deliveries` — a column per status, plus `error_code` and
`error_message` for the failure. A second receipt with the same wamid _and_ the
same status is dropped by the queue rather than applied twice, which is what
`jobKey('wast', id, status)` is for: Meta redelivers.

## What it still does not prove

That Meta accepts what the stub accepted, and that a real OAuth token behind
`archive` or `reply` behaves as the provider adapters expect. Both need
credentials. `pnpm preflight` is the check for the first one; `docs/getting-started.md`
is the walkthrough for the second.
