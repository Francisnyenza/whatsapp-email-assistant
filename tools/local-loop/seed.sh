#!/usr/bin/env bash
#
# Seeds the fixture the local loop runs against.
#
#   set -a && . ./.env && set +a
#   FROM=15559990007 tools/local-loop/seed.sh
#
# A user with a verified number, one email, the outbound card to reply to, and
# an open 24-hour messaging window.
#
# The OAuth tokens are real ciphertext under `ENCRYPTION_MASTER_KEY`, not
# placeholder bytes. That matters more than it sounds: the command pipeline
# decrypts the mailbox token before it dispatches anything, so a fake one stops
# every command — including the ones that never touch a mailbox, like `snooze` —
# at ENCRYPTION_FAILURE, several steps before the code being exercised. With a
# decryptable token the run reaches the provider call itself and fails there
# instead, which is the honest boundary: `fetch failed`, because the token is
# not a real Google grant.
set -euo pipefail

: "${DATABASE_URL:?source the same .env the API is running with}"
: "${ENCRYPTION_MASTER_KEY:?required to seal the fixture tokens}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PHONE="+${FROM:-15559990007}"

# The fixture user's id is fixed so the assertions afterwards can name it, and
# so a re-run replaces the previous fixture rather than accumulating users.
USER_ID='11111111-1111-4111-8111-111111111111'

# Sealed through the same envelope layer production uses, with the same AAD
# binding — `userId:field` — so a fixture that decrypts here proves the binding
# is right rather than bypassing it.
read -r ACCESS_CIPHER ACCESS_DEK KEY_VERSION REFRESH_CIPHER REFRESH_DEK <<EOF
$(node --input-type=module -e "
import { EnvelopeEncryption, LocalKmsProvider } from '$ROOT/packages/crypto/dist/index.js';

const crypto = new EnvelopeEncryption(
  new LocalKmsProvider(Buffer.from(process.env.ENCRYPTION_MASTER_KEY, 'base64')),
);
const userId = '$USER_ID';

const access = await crypto.encryptString('ya29.not-a-real-grant', { userId, field: 'accessToken' });
const refresh = await crypto.encryptString('1//not-a-real-refresh', { userId, field: 'refreshToken' });

const hex = (buffer) => Buffer.from(buffer).toString('hex');
process.stdout.write([
  hex(access.ciphertext), hex(access.wrappedKey), access.keyVersion,
  hex(refresh.ciphertext), hex(refresh.wrappedKey),
].join(' '));
")
EOF

psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 \
  -v phone="$PHONE" \
  -v access_cipher="$ACCESS_CIPHER" \
  -v access_dek="$ACCESS_DEK" \
  -v key_version="$KEY_VERSION" \
  -v refresh_cipher="$REFRESH_CIPHER" \
  -v refresh_dek="$REFRESH_DEK" \
  -f "$HERE/seed.sql"

echo "seeded $PHONE"
