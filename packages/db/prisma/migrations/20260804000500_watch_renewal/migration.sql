-- Renewing a Gmail watch before it lapses.
--
-- `users.watch` expires after seven days. Nothing about that expiry is
-- announced: pushes simply stop, the mailbox goes quiet, and the user's mail
-- stops reaching WhatsApp with no error anywhere. So a sweep has to find
-- mailboxes whose watch is about to lapse and re-issue it.
--
-- The sweep runs on a timer, not on behalf of a user, so it has no tenant
-- context — the same problem the push endpoint has, and it is solved the same
-- way. Reading `email_accounts` across tenants would mean either relaxing RLS
-- on the table holding OAuth token ciphertext, or running the sweep as a role
-- that bypasses RLS. Both trade the strongest isolation property in the system
-- for a scheduling convenience.
--
-- Instead the expiry is mirrored onto `provider_account_routes`, which is
-- already outside tenant isolation because it is consulted to *determine* the
-- tenant. A timestamp is not a secret: this tells an attacker who reached the
-- table when a mailbox's subscription lapses, which they already knew from the
-- seven-day cadence. The renewal itself still runs fully tenant-scoped — the
-- route yields only a (user_id, account_id) pair, and every read of the token
-- that follows goes through RLS as that user.
--
-- `email_accounts.watch_expires_at` remains the source of truth. This column is
-- an index into it, written in the same transaction so the two cannot diverge.
ALTER TABLE provider_account_routes
  ADD COLUMN IF NOT EXISTS watch_expires_at timestamp(3);

-- NULLS FIRST because a NULL expiry means "no watch at all" — an account that
-- fell back to polling when its watch could not be established. Those are the
-- most urgent, not the least, so the sweep must see them first.
CREATE INDEX IF NOT EXISTS provider_account_routes_watch_renewal_idx
  ON provider_account_routes (watch_expires_at NULLS FIRST);

-- Backfill from the source of truth for mailboxes connected before this
-- migration. Without it every existing route looks like it has no watch, and
-- the first sweep would re-issue a watch for every connected mailbox at once.
UPDATE provider_account_routes r
   SET watch_expires_at = a.watch_expires_at
  FROM email_accounts a
 WHERE a.id = r.account_id;
