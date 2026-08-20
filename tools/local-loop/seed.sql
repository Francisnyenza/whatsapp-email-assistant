-- A user, an email, and the outbound card to reply to.
--
-- Everything the local loop needs and nothing it does not. Run it with the
-- phone number the webhook scripts will send from:
--
--   psql "$DATABASE_URL" -v phone="'+15559990007'" -f tools/local-loop/seed.sql
--
-- Run it through seed.sh rather than directly: the OAuth token columns are real
-- ciphertext under ENCRYPTION_MASTER_KEY, and that script is what seals them.
-- The tokens decrypt but are not real Google grants, so a command that reaches
-- the mail provider fails at the HTTP call rather than several steps earlier.

\set QUIET on
\pset tuples_only on
\pset format unaligned

BEGIN;

-- Fixture ids, so the assertions afterwards can name them.
\set uid '''11111111-1111-4111-8111-111111111111'''
\set aid '''22222222-2222-4222-8222-222222222222'''
\set tid '''33333333-3333-4333-8333-333333333333'''
\set mid '''44444444-4444-4444-8444-444444444444'''

DELETE FROM users WHERE id = :uid::uuid;

INSERT INTO users (id, email, status, timezone, phone_number, phone_verified, created_at, updated_at)
VALUES (:uid::uuid, 'e2e@example.com', 'active', 'Africa/Nairobi', :'phone', true, now(), now());

SET LOCAL app.current_user_id = '11111111-1111-4111-8111-111111111111';

INSERT INTO email_accounts (
  id, user_id, provider, email_address, display_name, status,
  access_token_cipher, access_token_dek, token_key_version, provider_account_id,
  refresh_token_cipher, refresh_token_dek, token_expires_at,
  consecutive_failures, is_primary, created_at, updated_at
) VALUES (
  :aid::uuid, :uid::uuid, 'gmail', 'me@example.com', 'Me', 'active',
  decode(:'access_cipher', 'hex'), decode(:'access_dek', 'hex'), :key_version, 'provider-acct-1',
  decode(:'refresh_cipher', 'hex'), decode(:'refresh_dek', 'hex'), now() + interval '1 hour',
  0, true, now(), now()
);

INSERT INTO email_threads (id, user_id, account_id, provider_thread_id, subject, last_message_at, created_at, updated_at)
VALUES (:tid::uuid, :uid::uuid, :aid::uuid, 'thr-1', 'Q3 report', now(), now(), now());

INSERT INTO email_messages (
  id, user_id, account_id, thread_id, provider_message_id, message_id_header,
  subject, from_address, from_name, to_addresses, sent_at, received_at,
  snippet, content_hash, created_at, updated_at
) VALUES (
  :mid::uuid, :uid::uuid, :aid::uuid, :tid::uuid, 'msg-1', '<q3@acme.com>',
  'Q3 report', 'sarah.chen@acme.com', 'Sarah Chen', ARRAY['me@example.com'], now(), now(),
  'Can you review the Q3 numbers before Friday?', 'hash-1', now(), now()
);

-- The outbound card the user is about to reply to. Rank 1 on the resolution
-- ladder: a native reply to this wamid resolves to that email.
INSERT INTO whatsapp_deliveries (
  id, user_id, email_message_id, whatsapp_message_id, phone_number,
  kind, status, was_template, attempts, sent_at, created_at
) VALUES (
  gen_random_uuid(), :uid::uuid, :mid::uuid, 'wamid.SEED.OUT.0001', :'phone',
  'notification', 'sent', false, 0, now(), now()
);

-- An open 24-hour window, so the reply is sent as a card rather than deferred.
INSERT INTO conversation_states (id, user_id, active_email_message_id, active_thread_id, last_inbound_at, expires_at, updated_at)
VALUES (gen_random_uuid(), :uid::uuid, :mid::uuid, :tid::uuid, now(), now() + interval '24 hours', now());

COMMIT;
