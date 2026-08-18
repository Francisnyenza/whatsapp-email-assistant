-- Taking back the last thing you did.
--
-- `undo` has been a parsed intent since the command parser was written, and a
-- button action since the payload codec was. Both answered "not built" —
-- because nothing anywhere remembered what had just happened.
--
-- The record is deliberately separate from `pending_action`. That column holds a
-- question awaiting an answer (a send confirmation); this holds an answer
-- already given, so that "undo" reverses something specific rather than
-- guessing. Conflating them would mean a pending confirmation and a completed
-- action competing for one slot, and the loser would be silently unavailable.
--
-- One slot, not a stack: mail clients offer exactly one level of undo, and a
-- deeper history invites a user to walk backwards through changes their mailbox
-- has since had synced over them from another device.
ALTER TABLE conversation_states
  ADD COLUMN IF NOT EXISTS last_action    JSONB,
  ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ;
