#!/usr/bin/env bash
#
# Delivers a signed inbound message to a locally running API, the way Meta does.
#
#   ./send-webhook.sh "archive"
#   ./send-webhook.sh "reply saying I'll look Friday"
#
# Reads WHATSAPP_APP_SECRET, WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_PHONE_NUMBER_ID
# and API_BASE_URL from the environment, so source the same .env the API is using.
# FROM is the sender's number in Meta's format — E.164 without the '+'.
set -euo pipefail

: "${WHATSAPP_APP_SECRET:?source the same .env the API is running with}"
FROM="${FROM:-15559990007}"
API="${API_BASE_URL:-http://127.0.0.1:3001}"
WABA="${WHATSAPP_BUSINESS_ACCOUNT_ID:-987654321}"
PHONE_ID="${WHATSAPP_PHONE_NUMBER_ID:-123456789}"
# The card being replied to. Rank 1 on the resolution ladder (ADR 0003): a
# native reply carries the wamid of the message it answers.
CONTEXT="${CONTEXT:-wamid.SEED.OUT.0001}"

WAMID="wamid.IN.$(date +%s%N | tail -c 8)"
BODY=$(cat <<JSON
{"object":"whatsapp_business_account","entry":[{"id":"$WABA","changes":[{"field":"messages","value":{
  "messaging_product":"whatsapp",
  "metadata":{"display_phone_number":"15551230000","phone_number_id":"$PHONE_ID"},
  "contacts":[{"profile":{"name":"Local"},"wa_id":"$FROM"}],
  "messages":[{"id":"$WAMID","from":"$FROM","timestamp":"$(date +%s)","type":"text",
    "context":{"id":"$CONTEXT","from":"15551230000"},
    "text":{"body":"$1"}}]
}}]}]}
JSON
)

# The signature is over the exact bytes, which is why --data-binary matters:
# the API verifies against the raw body, not a re-serialization of it.
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" -binary | od -An -tx1 -v | tr -d ' \n')

echo "wamid: $WAMID"
curl -s -o /dev/null -w 'webhook HTTP %{http_code}\n' \
  -XPOST "$API/webhooks/whatsapp" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  --data-binary "$BODY"
