-- An audit trail has to outlive the account it describes.
--
-- `audit_logs.user_id` carried a foreign key with ON DELETE SET NULL, on the
-- reasonable-sounding theory that a deleted user should not leave a dangling
-- reference. SET NULL is implemented as an UPDATE, and the append-only trigger
-- added in `20260804000100_hardening` rejects every UPDATE — so deleting a user
-- who has *any* audit row fails with "audit_logs is append-only".
--
-- Nothing noticed because nothing ever wrote an audit row. The moment the trail
-- became real, account deletion broke; found by a test that deletes a user and
-- then looks for their entries, which is the operation GDPR erasure performs.
--
-- The fix is to drop the constraint rather than to weaken the trigger. Two
-- reasons, and the second is the load-bearing one:
--
--   1. Referential integrity is the wrong property here. An audit row is a
--      record of something that happened, not a pointer to something that
--      exists; keeping the id after the user is gone preserves *more* of the
--      trail than nulling it, and "which account was this" is exactly what an
--      investigation asks about a deleted one.
--   2. An attacker who can delete an account must not thereby edit the record
--      of what they did with it. Relaxing the trigger to permit the SET NULL
--      would open UPDATE on the table to anything that can arrange a cascade,
--      which is the property the trigger exists to hold.
--
-- What this does not do is answer erasure. `user_id` on a surviving row is a
-- reference to a deleted person, and so is the `ip_address` beside it. The
-- application role deliberately cannot delete either — that is the point of an
-- append-only trail — so expiring them is an operator task running as the
-- owner, on the `RETENTION_AUDIT_DAYS` clock. `docs/runbook.md` has the
-- procedure and `docs/security.md` states the trade-off, because a system that
-- silently keeps a record of a person who asked to be forgotten should say so
-- out loud rather than in a migration comment.

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS "audit_logs_user_id_fkey";
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS "audit_logs_organization_id_fkey";

-- The index stays: it is what makes "everything this account did" a fast query,
-- and it was never the constraint that provided it.
