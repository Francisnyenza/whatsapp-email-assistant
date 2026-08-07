-- Semantic + fuzzy search over the mailbox.
--
-- The vector index and the subject/from_address trigram indexes were created in
-- `20260804000100_hardening`. What was missing is the sender's *display name*,
-- and it is the one people actually search by: "the invoice from Tom" names a
-- human, not an address. Without this index that arm of the hybrid query forces
-- a sequential scan of every message the user owns, which is precisely the shape
-- that looks fine in development and falls over at ten thousand rows.
CREATE INDEX IF NOT EXISTS email_messages_from_name_trgm_idx
  ON email_messages USING gin (from_name gin_trgm_ops);

-- Search only ever runs over live mail. A partial index on the deleted flag
-- keeps the candidate scans off trashed messages without a second predicate.
CREATE INDEX IF NOT EXISTS email_messages_live_received_idx
  ON email_messages (user_id, received_at DESC)
  WHERE deleted_at IS NULL;
