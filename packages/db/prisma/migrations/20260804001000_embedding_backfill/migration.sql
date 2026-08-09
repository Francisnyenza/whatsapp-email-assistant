-- Making a connected account's *history* searchable, not only its future.
--
-- Embedding happens after an email is notified, so search only ever knew about
-- mail that arrived while the feature was running. An account connected today
-- had an unsearchable back catalogue and nothing to fix it.
--
-- The sweep pages over users and asks each, tenant-scoped, for messages with no
-- embedding. Without this column it would ask every user on every run forever,
-- including the ones with nothing left to do — so a completed backfill is
-- recorded, and the partial index makes "who is still owed one" the only
-- question the sweep has to ask.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS embedding_backfilled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_embedding_backfill_pending_idx
  ON users (id)
  WHERE embedding_backfilled_at IS NULL;

-- The anti-join the per-user query runs: live mail, oldest first, minus anything
-- already embedded. `message_embeddings (user_id, email_message_id)` covers the
-- other side and already exists.
CREATE INDEX IF NOT EXISTS email_messages_backfill_idx
  ON email_messages (user_id, received_at)
  WHERE deleted_at IS NULL;
