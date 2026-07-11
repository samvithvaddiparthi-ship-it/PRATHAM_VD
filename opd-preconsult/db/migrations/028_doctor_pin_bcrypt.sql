-- §8b — migrate doctor PIN hashes off unsalted SHA-256 onto bcrypt.
-- Lazy migration: a new `pin_hash_bcrypt` column is added here (empty for all
-- existing rows). On the next successful login the node backend verifies against
-- the legacy `pin_hash` (SHA-256), then rehashes the PIN with bcrypt and writes it
-- to `pin_hash_bcrypt`. Once populated, login verifies against bcrypt only. New
-- doctors / PIN resets write bcrypt directly. `pin_hash` is retained (not cleared
-- on lazy migrate) so the demo-PIN (1234) startup guard can still detect it.
DO $$ BEGIN
  ALTER TABLE doctors ADD COLUMN pin_hash_bcrypt VARCHAR(72) NOT NULL DEFAULT '';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
