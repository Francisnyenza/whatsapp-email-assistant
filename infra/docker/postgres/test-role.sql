-- Gives the restricted application role a password so tests can connect as it.
--
-- The hardening migration creates `wea_app` NOLOGIN, which is right for
-- production: there the application authenticates with an IAM token or a
-- secret-manager credential, and a password baked into a migration would be a
-- password in version control.
--
-- But the integration suite has to *connect* as that role. Its most important
-- assertions — that a tenant cannot read another tenant's mail, that the
-- retention sweep cannot erase someone else's body, that `audit_logs` refuses
-- an UPDATE — all pass vacuously against the owner, because Postgres exempts
-- the table owner and any superuser from row-level security. `wea_app` is what
-- makes them mean anything, and `assertTenantIsolationEnforceable()` refuses to
-- boot without it.
--
-- So this file exists, and it is deliberately not a migration: it is run
-- against local and CI databases only, by `pnpm db:test-role`. The password is
-- a fixed development credential and is not a secret. A production database
-- must never have this applied.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wea_app') THEN
    RAISE EXCEPTION
      'Role wea_app does not exist. Run the migrations first (pnpm db:migrate:deploy).';
  END IF;
END
$$;

ALTER ROLE wea_app LOGIN PASSWORD 'wea_app_password';

-- The role must be able to reach the database and the schema at all. The
-- migration grants table privileges; CONNECT is granted per database, which the
-- migration cannot know the name of.
GRANT CONNECT ON DATABASE :"db" TO wea_app;
GRANT USAGE ON SCHEMA public TO wea_app;

-- Fails loudly rather than leaving a suite that passes without proving
-- anything. A role that bypasses row-level security makes every isolation
-- assertion in the project vacuous, and the failure mode is silent: the tests
-- go green.
DO $$
DECLARE
  bypasses boolean;
BEGIN
  SELECT rolsuper OR rolbypassrls INTO bypasses FROM pg_roles WHERE rolname = 'wea_app';

  IF bypasses THEN
    RAISE EXCEPTION 'wea_app bypasses row-level security; the isolation tests would be vacuous.';
  END IF;
END
$$;
