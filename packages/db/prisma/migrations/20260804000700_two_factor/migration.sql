-- Making two-factor authentication actually work.
--
-- The schema has carried an encrypted TOTP secret and a recovery-code list since
-- the beginning, and the access token has carried an `mfa` claim. Nothing ever
-- verified a code, so enabling 2FA made an account *less* usable rather than
-- more protected. Three columns close that.

-- The last time step this user successfully redeemed.
--
-- This is what makes a one-time password one-time. A TOTP code stays
-- arithmetically valid for its whole thirty-second window, so a code read off a
-- screen — or captured in a phishing proxy — can be replayed within it unless
-- the spent step is remembered and anything at or below it refused.
--
-- bigint rather than integer: the step is unix seconds / 30, which passes 2^31
-- in 2038 along with everything else that used a 32-bit time.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS two_factor_last_used_step bigint;

-- When enrolment was completed by proving a code works.
--
-- Enrolment is two steps for a reason: a secret is stored first, and
-- `two_factor_enabled` is only set once the user has produced a valid code from
-- it. Without that, a mistyped or unscanned secret locks the account out at the
-- next sign-in — the precise failure this feature is supposed to prevent. The
-- timestamp records which of the two states a half-enrolled account is in.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS two_factor_confirmed_at timestamp(3);

-- When this session satisfied the second factor.
--
-- On the session rather than only in the access token, because access tokens
-- are short-lived and rotate. Deriving it from the user's `two_factor_enabled`
-- alone — as the code did before — means every refresh hands back a token with
-- `mfa: false`, and the user is asked for a code every fifteen minutes forever.
-- Recording it here lets a refresh carry forward what was already proven, while
-- keeping the proof per-session: verifying on a laptop does not silently
-- authorize a session someone else opened.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mfa_satisfied_at timestamp(3);
