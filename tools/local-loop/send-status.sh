#!/usr/bin/env bash
#
# Delivers a signed delivery receipt, the way Meta does after a send.
#
#   ./send-status.sh wamid.STUB.0003 delivered
#   ./send-status.sh wamid.STUB.0002 failed 131047 "Re-engagement message"
#
# The `failed` form is the one worth exercising: Meta answers a send with 200
# and reports the failure asynchronously, so this is the only thing that tells
# the system a message did not arrive.
set -euo pipefail

: "${WHATSAPP_APP_SECRET:?source the same .env the API is running with}"
WAMID="${1:?usage: send-status.sh <wamid> <sent|delivered|read|failed> [code] [title]}"
STATUS="${2:?usage: send-status.sh <wamid> <sent|delivered|read|failed> [code] [title]}"
CODE="${3:-}"
TITLE="${4:-}"

RECIPIENT="${FROM:-15559990007}"
API="${API_BASE_URL:-http://127.0.0.1:3001}"
WABA="${WHATSAPP_BUSINESS_ACCOUNT_ID:-987654321}"
PHONE_ID="${WHATSAPP_PHONE_NUMBER_ID:-123456789}"

DETAILS="${5:-}"
ERRORS=""
if [ -n "$CODE" ]; then
  ERRORS=",\"errors\":[{\"code\":$CODE,\"title\":\"$TITLE\""
  [ -n "$DETAILS" ] && ERRORS="$ERRORS,\"error_data\":{\"details\":\"$DETAILS\"}"
  ERRORS="$ERRORS}]"
fi

BODY=$(cat <<JSON
{"object":"whatsapp_business_account","entry":[{"id":"$WABA","changes":[{"field":"messages","value":{
  "messaging_product":"whatsapp",
  "metadata":{"display_phone_number":"15551230000","phone_number_id":"$PHONE_ID"},
  "statuses":[{"id":"$WAMID","recipient_id":"$RECIPIENT","status":"$STATUS","timestamp":"$(date +%s)"$ERRORS}]
}}]}]}
JSON
)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET" -binary | od -An -tx1 -v | tr -d ' \n')

curl -s -o /dev/null -w "status $STATUS -> HTTP %{http_code}\n" \
  -XPOST "$API/webhooks/whatsapp" \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  --data-binary "$BODY"
