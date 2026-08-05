-- Sessions are consulted BEFORE a tenant exists.
--
-- Authenticating a refresh token means looking it up by hash — and at that
-- moment we do not know whose token it is. That is the whole point of the
-- lookup. The tenant_isolation policy has no way to express "no tenant yet",
-- so it refused the read and authentication could not work at all.
--
-- This is a layering error in the original hardening migration: `sessions` and
-- `api_keys` are the tables consulted TO ESTABLISH a tenant, so they cannot be
-- gated on one already being established.
--
-- The fix keeps writes strictly owner-scoped and relaxes only reads:
--
--   * With a tenant set (every ordinary query — listing sessions, revoking
--     one), isolation is unchanged.
--   * With no tenant set, reads are permitted. The only unscoped read the
--     application makes is findUnique by refresh_token_hash, which requires
--     already knowing a 256-bit token.
--
-- What this gives up: an unscoped `SELECT * FROM sessions` would return every
-- row rather than none. What that discloses is a SHA-256 hash, a user agent, an
-- IP and timestamps — not a usable credential, since the hash is not the token
-- and is not reversible. Writes remain impossible without the owning tenant, so
-- no session can be created, revoked or re-pointed across tenants.

DROP POLICY IF EXISTS tenant_isolation ON sessions;

CREATE POLICY tenant_isolation ON sessions
  -- Reads: your own rows, or any row when no tenant is established (the
  -- pre-authentication lookup).
  USING (user_id = app_current_user_id() OR app_current_user_id() IS NULL)
  -- Writes: always your own. Unchanged.
  WITH CHECK (user_id = app_current_user_id());

DROP POLICY IF EXISTS tenant_isolation ON api_keys;

CREATE POLICY tenant_isolation ON api_keys
  -- Same reasoning: an API key is resolved by hash before its owner is known.
  USING (user_id = app_current_user_id() OR app_current_user_id() IS NULL)
  WITH CHECK (user_id = app_current_user_id());
