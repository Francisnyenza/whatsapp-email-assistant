-- Hardening and performance objects that Prisma's schema language cannot express.
--
-- Everything here is idempotent so it can be re-run against an environment that
-- already has some of it.

-- ============================================================================
-- 1. Semantic search index
-- ============================================================================
-- HNSW over cosine distance. Chosen over IVFFlat because recall stays high
-- without a training step, which matters when the corpus grows continuously
-- rather than being loaded once.
--
-- m=16, ef_construction=64 are pgvector's defaults and are a reasonable
-- build-time/recall trade-off at our dimensionality (1536).
CREATE INDEX IF NOT EXISTS message_embeddings_vector_idx
  ON message_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Semantic search is always scoped to one user. Without this, the planner may
-- scan the whole HNSW index and filter afterwards, which gets slower as the
-- table grows rather than staying flat.
CREATE INDEX IF NOT EXISTS message_embeddings_user_message_idx
  ON message_embeddings (user_id, email_message_id);

-- ============================================================================
-- 2. Full-text and fuzzy search
-- ============================================================================
-- Trigram indexes back "search emails from Sarah" and subject search, where the
-- user's phrasing rarely matches the stored value exactly.
CREATE INDEX IF NOT EXISTS email_messages_subject_trgm_idx
  ON email_messages USING gin (subject gin_trgm_ops);

CREATE INDEX IF NOT EXISTS email_messages_from_trgm_idx
  ON email_messages USING gin (from_address gin_trgm_ops);

CREATE INDEX IF NOT EXISTS contacts_name_trgm_idx
  ON contacts USING gin (display_name gin_trgm_ops);

-- Keyword search over subject + snippet, scoped per user by the query.
CREATE INDEX IF NOT EXISTS email_messages_fts_idx
  ON email_messages
  USING gin (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(snippet, '')));

-- ============================================================================
-- 3. Partial indexes for the hot paths
-- ============================================================================
-- These are the queries that run constantly. Partial indexes keep them small:
-- unread is a fraction of all mail, and due reminders a fraction of all rows.

CREATE INDEX IF NOT EXISTS email_messages_unread_idx
  ON email_messages (user_id, received_at DESC)
  WHERE is_unread = true AND is_archived = false AND is_spam = false;

CREATE INDEX IF NOT EXISTS email_messages_needs_attention_idx
  ON email_messages (user_id, received_at DESC)
  WHERE is_archived = false AND is_spam = false;

CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders (remind_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS drafts_pending_send_idx
  ON drafts (created_at)
  WHERE status IN ('queued', 'sending');

-- The watch-renewal sweep: only active accounts can have an expiring watch.
CREATE INDEX IF NOT EXISTS email_accounts_watch_renewal_idx
  ON email_accounts (watch_expires_at)
  WHERE status = 'active';

-- Sessions cleanup and the "active sessions" list.
CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON sessions (user_id, last_used_at DESC)
  WHERE revoked_at IS NULL;

-- ============================================================================
-- 4. Append-only audit log
-- ============================================================================
-- An audit log that can be edited by the code it audits is not an audit log.
-- The application role is granted INSERT and SELECT only (§6), and this trigger
-- is the second line of defence: even a role with UPDATE cannot rewrite history.
CREATE OR REPLACE FUNCTION audit_logs_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_reject_mutation();

-- ============================================================================
-- 5. Row-level security
-- ============================================================================
-- The application already scopes every query by user_id through the repository
-- layer. RLS is the second lock on the same door: a missing WHERE clause in new
-- code returns zero rows instead of another tenant's mail.
--
-- The API sets `SET LOCAL app.current_user_id = '<uuid>'` at the start of each
-- transaction. Background jobs that legitimately span users (the retention
-- sweep, admin tooling) connect as a role holding BYPASSRLS.

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  raw text;
BEGIN
  raw := current_setting('app.current_user_id', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  -- A malformed setting must deny access, not error out mid-query.
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'email_accounts',
    'email_threads',
    'email_messages',
    'attachments',
    'message_analyses',
    'message_embeddings',
    'whatsapp_deliveries',
    'whatsapp_inbound_messages',
    'conversation_states',
    'drafts',
    'user_preferences',
    'ai_memory',
    'contacts',
    'automation_rules',
    'automation_runs',
    'reminders',
    'ai_usage_records',
    'sessions',
    'api_keys'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (user_id = app_current_user_id())
        WITH CHECK (user_id = app_current_user_id())
    $f$, t);
  END LOOP;
END;
$$;

-- ============================================================================
-- 6. Least-privilege application role
-- ============================================================================
-- Created only if absent so local development, where the owner role is reused,
-- does not fail. Production provisions this role via Terraform and the app
-- connects as it — never as the owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wea_app') THEN
    CREATE ROLE wea_app NOLOGIN;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO wea_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wea_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wea_app;

-- Audit logs are the exception: insert and read, never modify.
REVOKE UPDATE, DELETE ON audit_logs FROM wea_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wea_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wea_app;

-- ============================================================================
-- 7. Guard rails on encrypted columns
-- ============================================================================
-- Envelope encryption stores ciphertext and its wrapped key together (ADR 0002).
-- A row with one and not the other is undecryptable — better to reject the write
-- than to discover it during an incident.
ALTER TABLE email_messages
  DROP CONSTRAINT IF EXISTS email_messages_body_key_pairing;
ALTER TABLE email_messages
  ADD CONSTRAINT email_messages_body_key_pairing CHECK (
    (body_text_cipher IS NULL AND body_html_cipher IS NULL)
    OR (body_dek IS NOT NULL AND body_key_version IS NOT NULL)
  );

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_two_factor_key_pairing;
ALTER TABLE users
  ADD CONSTRAINT users_two_factor_key_pairing CHECK (
    two_factor_secret_cipher IS NULL
    OR (two_factor_secret_dek IS NOT NULL AND two_factor_secret_key_ver IS NOT NULL)
  );

ALTER TABLE email_accounts
  DROP CONSTRAINT IF EXISTS email_accounts_refresh_key_pairing;
ALTER TABLE email_accounts
  ADD CONSTRAINT email_accounts_refresh_key_pairing CHECK (
    refresh_token_cipher IS NULL OR refresh_token_dek IS NOT NULL
  );

-- Scores are probabilities; a model returning 7.0 must not be persisted.
ALTER TABLE message_analyses
  DROP CONSTRAINT IF EXISTS message_analyses_scores_in_range;
ALTER TABLE message_analyses
  ADD CONSTRAINT message_analyses_scores_in_range CHECK (
    urgency_score >= 0 AND urgency_score <= 1
    AND spam_score >= 0 AND spam_score <= 1
  );
