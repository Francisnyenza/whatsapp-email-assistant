-- Allow inbound WhatsApp messages that belong to no tenant.
--
-- Anyone can message a business number, including someone with no connected
-- account. We record those for operator visibility — an unexplained silence is
-- much harder to debug than a logged message we chose not to act on.
--
-- Such a row has no owner, and the tenant_isolation policy has no rule for that
-- case: `user_id = app_current_user_id()` is NULL for a NULL user_id, so the
-- insert is refused. That is the policy being correct, not a bug — it simply
-- never contemplated an ownerless row.
--
-- The fix keeps reads strictly owner-scoped (an unattributed message is
-- readable by NO tenant, which is what we want) while permitting the write.
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_inbound_messages;

CREATE POLICY tenant_isolation ON whatsapp_inbound_messages
  -- Reads: your own rows only. Ownerless rows are invisible to every tenant and
  -- reachable solely by an operator connecting with elevated privileges.
  USING (user_id = app_current_user_id())
  -- Writes: your own rows, or a row belonging to nobody.
  WITH CHECK (user_id = app_current_user_id() OR user_id IS NULL);
