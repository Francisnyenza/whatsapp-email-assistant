-- Routing a provider push to the account it concerns.
--
-- A Gmail Pub/Sub notification names only the mailbox address and a historyId.
-- Resolving that to a user must therefore happen before any tenant context
-- exists — something row-level security has no way to express.
--
-- The obvious fix would be to relax RLS reads on `email_accounts`, as was done
-- for `sessions`. That is the wrong trade here: `email_accounts` holds OAuth
-- token ciphertext, and widening read access to the table holding credentials
-- in order to solve a routing problem is a poor exchange.
--
-- This table carries no secrets — a provider, an address, and two ids — and is
-- deliberately left outside tenant isolation. Compromising it reveals which
-- addresses are connected, not the ability to read any of them.
CREATE TABLE provider_account_routes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         "MailProvider" NOT NULL,
  provider_address text NOT NULL,
  user_id          uuid NOT NULL,
  account_id       uuid NOT NULL,
  created_at       timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX provider_account_routes_provider_address_key
  ON provider_account_routes (provider, provider_address);
CREATE INDEX provider_account_routes_account_id_idx
  ON provider_account_routes (account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON provider_account_routes TO wea_app;

-- Deliberately no RLS: this table is consulted to determine the tenant.
