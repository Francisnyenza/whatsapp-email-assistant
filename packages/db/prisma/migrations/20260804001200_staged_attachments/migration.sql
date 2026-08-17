-- Files the user sends *into* the chat, on their way out on an email.
--
-- The direction that was missing. A photo or a PDF sent in WhatsApp reached the
-- webhook parser, which understood it perfectly, and then went nowhere: there
-- was no producer for it, so the product could deliver an attachment and could
-- not accept one.
--
-- What this table deliberately does not hold is the file. Meta retains inbound
-- media for 30 days and serves it against the media id, so a reference is
-- enough — and a reference means a file the user staged and never sent is a
-- file we never stored. The bytes are fetched once, at send time, straight into
-- the MIME message.
--
-- `size_bytes` is resolved at staging time rather than at send time because the
-- budget has to be checked before the user is told the email is going. The
-- webhook carries no size; Meta's media metadata endpoint does.
CREATE TABLE IF NOT EXISTS staged_attachments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  whatsapp_media_id   TEXT NOT NULL,
  -- Unique: Meta redelivers a webhook on any non-2xx, and staging the same
  -- photo twice would attach it to the email twice.
  whatsapp_message_id TEXT NOT NULL UNIQUE,
  filename            TEXT NOT NULL,
  mime_type           TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  -- Null until a draft claims it: the file is waiting for the user to say what
  -- to do with it.
  draft_id            UUID REFERENCES drafts (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL
);

-- The pending-set lookup: this user's unclaimed, unexpired files.
CREATE INDEX IF NOT EXISTS staged_attachments_pending_idx
  ON staged_attachments (user_id, draft_id, created_at);

-- The send path's lookup, by draft.
CREATE INDEX IF NOT EXISTS staged_attachments_draft_idx
  ON staged_attachments (draft_id);

-- The sweep's.
CREATE INDEX IF NOT EXISTS staged_attachments_expires_idx
  ON staged_attachments (expires_at);

-- Same second lock as every other tenant table: a query that forgets its
-- WHERE clause returns nothing rather than another user's files.
ALTER TABLE staged_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staged_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staged_attachments;
CREATE POLICY tenant_isolation ON staged_attachments
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

-- The default privileges from the hardening migration cover tables created
-- afterwards, but only for roles that existed when they were set. Granting
-- explicitly costs nothing and removes the question.
GRANT SELECT, INSERT, UPDATE, DELETE ON staged_attachments TO wea_app;
