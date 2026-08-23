#!/usr/bin/env bash
#
# Creates .env with the secrets this system generates for itself.
#
#   ./tools/setup-env.sh
#
# It never prints a secret. The values it writes are the ones no provider can
# give you — an encryption key, a blind-index key, a token-signing secret — and
# they exist only in your .env from that point on.
#
# What it deliberately leaves empty is everything from Meta and Google. Those
# you paste in yourself; `pnpm preflight` will tell you which are missing and
# what each one should look like.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env.example ]; then
  echo "No .env.example — are you in the repository root?" >&2
  exit 1
fi

if [ -f .env ]; then
  echo ".env already exists. Refusing to overwrite it — a regenerated"
  echo "ENCRYPTION_MASTER_KEY cannot decrypt anything written under the old one."
  echo
  echo "If you want a fresh one, move the existing file aside first."
  exit 1
fi

cp .env.example .env

# `sed -i` differs between GNU and BSD, and a wrong invocation here silently
# leaves the placeholder in place — which boots fine and fails at the first
# encrypted write.
set_value() {
  local key="$1" value="$2"
  python3 - "$key" "$value" <<'PY'
import re, sys
key, value = sys.argv[1], sys.argv[2]
text = open('.env').read()
pattern = rf'^{re.escape(key)}=.*$'
if not re.search(pattern, text, re.M):
    raise SystemExit(f'{key} is not in .env.example — has it been renamed?')
open('.env', 'w').write(re.sub(pattern, f'{key}={value}', text, count=1, flags=re.M))
PY
}

# 32 bytes each: AES-256 needs exactly that, and the schema rejects any other
# length rather than truncating silently.
set_value ENCRYPTION_MASTER_KEY "$(openssl rand -base64 32)"
set_value BLIND_INDEX_KEY "$(openssl rand -base64 32)"

# Signs the access token. The refresh token is a random string stored as a
# hash, not a JWT, so JWT_REFRESH_SECRET is left alone — it signs nothing.
set_value JWT_ACCESS_SECRET "$(openssl rand -base64 48)"

# You will type this same string into Meta's webhook configuration. It is not a
# credential so much as a shared word, but there is no reason to choose a
# guessable one.
set_value WHATSAPP_WEBHOOK_VERIFY_TOKEN "$(openssl rand -hex 16)"

cat <<'DONE'
Wrote .env with generated secrets. Nothing was printed.

ENCRYPTION_MASTER_KEY wraps every stored OAuth token and message body. Losing it
means losing access to all of them — there is no recovery path, by design. Keep
it wherever you keep passwords.

Next, fill in from Meta and Google:

  WHATSAPP_PHONE_NUMBER_ID       API Setup — the id, not the number
  WHATSAPP_BUSINESS_ACCOUNT_ID   API Setup
  WHATSAPP_BUSINESS_NUMBER       your number, +E.164
  WHATSAPP_ACCESS_TOKEN          a System User token, not the 24-hour one
  WHATSAPP_APP_SECRET            App Settings → Basic
  GOOGLE_CLIENT_ID               APIs & Services → Credentials
  GOOGLE_CLIENT_SECRET
  GOOGLE_REDIRECT_URI            must match the console exactly

Then:  pnpm infra:up && pnpm db:migrate && pnpm preflight
DONE
