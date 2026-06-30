-- Phone-number OTP verification at patient entry.
--
-- A patient must verify ownership of the phone number (one-time code over SMS)
-- before they can register. Multiple people legitimately share one phone (poor
-- families often have a single number), so verification is per-SESSION, not a
-- claim that one human owns the number — it only proves the SMS reached this
-- device during this visit.

-- Marks that the phone on this session passed OTP verification. /register refuses
-- to write patient identity until this is true.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;

-- Short-lived OTP codes. We never store the plaintext code — only a salted hash —
-- and cap attempts to make brute force impractical. Rows are disposable; the
-- latest unexpired row per phone is the active challenge.
CREATE TABLE IF NOT EXISTS phone_otps (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL,         -- E.164 (+91XXXXXXXXXX)
  session_id  UUID         REFERENCES sessions(id) ON DELETE CASCADE,
  code_hash   TEXT         NOT NULL,         -- HMAC-SHA256(code) — never the code
  expires_at  TIMESTAMPTZ  NOT NULL,
  attempts    INT          NOT NULL DEFAULT 0,
  verified    BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_otps_phone    ON phone_otps (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_otps_session  ON phone_otps (session_id);
