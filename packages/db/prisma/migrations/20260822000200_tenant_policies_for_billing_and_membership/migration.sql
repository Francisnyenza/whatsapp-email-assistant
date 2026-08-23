-- The last two tables carrying a user_id with no tenant policy.
--
-- `20260804000100_hardening` enumerated the tables to protect and these two were
-- not on the list. `docs/status.md` has named the omission as a gap rather than
-- a design ever since the RLS sweep found it, and `tenant-isolation.integration.spec.ts`
-- pins the set of unprotected tables with an equality assertion so it cannot
-- quietly grow. This closes it.
--
-- `audit_logs` and `provider_account_routes` stay unprotected, and both are
-- deliberate: an audit entry for a sign-in against an address that does not
-- exist has no tenant to scope to — a policy would refuse precisely the row an
-- investigation wants — and the route table is read *to discover* which tenant
-- a provider push belongs to, which RLS cannot express.
--
-- WITH CHECK (false) on both, which is stricter than the tenant tables above.
-- Nothing in the application reads or writes either one yet: billing is not
-- built and there is no Stripe code, invitations are not built and nothing
-- creates a membership. A policy permitting writes that nothing performs is a
-- policy that only helps an attacker — with SQL injection through the app role,
-- `INSERT INTO org_memberships (user_id, organization_id, role)` naming
-- yourself as an owner of somebody else's organisation is a complete takeover,
-- and `user_id = app_current_user_id()` would have allowed exactly that. When
-- invitation acceptance and the Stripe webhook are built, each gets an explicit
-- policy describing what it is allowed to write.

ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org_memberships;

-- A member sees their own membership rows and nobody else's. An organisation
-- admin viewing the whole roster is a feature that does not exist; when it
-- does, it needs a policy that says so rather than the absence of one.
CREATE POLICY tenant_isolation ON org_memberships
  USING (user_id = app_current_user_id())
  WITH CHECK (false);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subscriptions;

-- `user_id` is nullable here: a subscription belongs to a user *or* to an
-- organisation. Scoping on `user_id` alone would hide every org-owned plan from
-- every member of that org, so membership is the second route in.
--
-- The subquery is filtered explicitly even though `org_memberships`' own policy
-- already restricts it to the caller. Policy expressions are evaluated as the
-- querying role, so the inner policy does apply — but relying on that would
-- make this policy's correctness depend on the other one never widening, and
-- the belt-and-braces reasoning that put RLS behind the repository layer in the
-- first place applies here too.
CREATE POLICY tenant_isolation ON subscriptions
  USING (
    user_id = app_current_user_id()
    OR organization_id IN (
      SELECT organization_id
      FROM org_memberships
      WHERE user_id = app_current_user_id()
    )
  )
  WITH CHECK (false);
