-- Proving a phone number belongs to the person claiming it.
--
-- `phone_verified` has existed since the first migration and nothing has ever
-- read it, which made it a column that reads as a safeguard and is not one. That
-- matters more here than for most flags, because this number decides where a
-- user's private email is delivered:
--
--   * A typo at signup sends someone's inbox summaries to a stranger's phone,
--     with nothing to catch it.
--   * `phone_number` is UNIQUE, so claiming a number you do not own also squats
--     it — the real owner can then never register their own.
--   * And an inbound WhatsApp message resolves to whoever claimed the number, so
--     the squatter's mailbox is the one the victim's messages act on.
--
-- The flow that fixes it runs *inbound*: we show the user a code, they send it
-- to our WhatsApp number from their own phone. That proves possession without
-- needing an approved template, and it opens the 24-hour messaging window at the
-- same moment — which is the window the first notification needs anyway.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone_verification_code_hash TEXT,
  ADD COLUMN IF NOT EXISTS phone_verification_expires_at TIMESTAMPTZ;

-- The lookup is by code, from a number we do not yet know — so it has to be
-- indexed, and unique, because two users must never hold the same live code.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_verification_code_idx
  ON users (phone_verification_code_hash)
  WHERE phone_verification_code_hash IS NOT NULL;

-- Any number stored before verification existed was never proved. Clearing them
-- costs those users one verification and is the only honest thing to do with a
-- value that decides where private mail is sent.
UPDATE users
   SET phone_number = NULL,
       phone_verified = false
 WHERE phone_verified = false
   AND phone_number IS NOT NULL;
