-- Deleting an email from WhatsApp.
--
-- "Delete" means the provider's trash, not destruction: Gmail keeps a trashed
-- message for thirty days and the user can restore it from any client. Mirroring
-- that as a row deletion here would be a harsher operation than the one the user
-- authorized, and would take the WhatsApp delivery record with it — the record
-- that lets a native reply resolve back to an email, and the record that answers
-- "you told me you deleted it, when?".
--
-- So deletion is a timestamp. The message stops being offered as something to
-- act on, and everything about what happened to it survives.
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS deleted_at timestamp(3);

-- The resolver's candidate query filters on this, and almost every row is NULL,
-- so the index only carries the exceptions.
CREATE INDEX IF NOT EXISTS email_messages_deleted_idx
  ON email_messages (user_id, deleted_at)
  WHERE deleted_at IS NOT NULL;
