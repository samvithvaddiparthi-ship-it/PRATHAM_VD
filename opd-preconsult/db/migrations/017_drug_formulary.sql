-- Drug formulary + interaction store (curated, HIS-admin editable) and the
-- AI review queue. python-backend also ensures/​seeds these on startup
-- (src/drug_repo.py), so this migration is for fresh installs / documentation.
-- All idempotent.

CREATE TABLE IF NOT EXISTS drugs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generic     VARCHAR(128) UNIQUE NOT NULL,
  classes     TEXT[] NOT NULL DEFAULT '{}',
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  source      VARCHAR(16) NOT NULL DEFAULT 'seed',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS drug_interactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generic_a   VARCHAR(128) NOT NULL,
  generic_b   VARCHAR(128) NOT NULL,
  severity    VARCHAR(16) NOT NULL,
  description TEXT NOT NULL,
  source      VARCHAR(16) NOT NULL DEFAULT 'seed',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (generic_a, generic_b)
);

CREATE TABLE IF NOT EXISTS drug_class_interactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_a     VARCHAR(64) NOT NULL,
  class_b     VARCHAR(64) NOT NULL,
  severity    VARCHAR(16) NOT NULL,
  description TEXT NOT NULL,
  source      VARCHAR(16) NOT NULL DEFAULT 'seed',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (class_a, class_b)
);

CREATE TABLE IF NOT EXISTS allergy_class_map (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  allergen    VARCHAR(64) UNIQUE NOT NULL,
  drug_class  VARCHAR(64) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interaction_review_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unknown_drug  VARCHAR(128) NOT NULL,
  other_drug    VARCHAR(128) NOT NULL,
  ai_severity   VARCHAR(16),
  ai_description TEXT,
  ai_mechanism  TEXT,
  ai_confidence NUMERIC,
  model         VARCHAR(64),
  status        VARCHAR(16) NOT NULL DEFAULT 'pending',
  session_id    VARCHAR(64),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at   TIMESTAMPTZ,
  UNIQUE (unknown_drug, other_drug)
);
