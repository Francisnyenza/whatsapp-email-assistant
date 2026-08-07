-- Delivering mail that was held back.
--
-- `decideDelivery` returns `defer` for ordinary mail arriving outside the
-- messaging window, or while a user is in digest mode, or during quiet hours.
-- Nothing recorded that decision, so "deferred" and "delivered" were
-- indistinguishable afterwards and the held mail was simply never sent. These
-- two columns are what make a digest possible.

-- When we decided to hold this message back.
--
-- Cleared when it is finally delivered, so the column answers exactly one
-- question: what is this user still owed? It is deliberately not a boolean —
-- knowing *how long* something has been waiting is what distinguishes a digest
-- that is working from one that quietly stopped.
--
-- Suppressed mail never gets this. A muted sender or a below-threshold priority
-- is the user saying they do not want to hear about it, and resurfacing it in a
-- digest would override that.
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS notify_deferred_at timestamp(3);

-- Almost every row is NULL, so the index carries only the backlog.
CREATE INDEX IF NOT EXISTS email_messages_deferred_idx
  ON email_messages (user_id, notify_deferred_at)
  WHERE notify_deferred_at IS NOT NULL;

-- When this user last received a digest.
--
-- Without it the scheduled sweep re-sends at every tick: the backlog is only
-- cleared for messages actually included, and mail arriving a minute after the
-- 08:00 digest would trigger another one an hour later rather than waiting for
-- 18:00. It lives on the conversation state because that is where everything
-- about what we have said to this person already lives.
ALTER TABLE conversation_states
  ADD COLUMN IF NOT EXISTS last_digest_at timestamp(3);
