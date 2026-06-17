"""
Postgres-backed drug formulary + interaction store.

The curated data (drugs, specific pairs, class rules, allergy map) lives here so
the HIS admin can edit it. The AI fallback never writes these curated tables — it
only writes the non-authoritative `interaction_review_queue`, which an admin
approves into the curated tables.

On startup we ensure the schema exists and seed the curated tables from the
built-in defaults in drug_data.py / drug_interactions.py ONLY IF they're empty,
so admin edits persist across restarts (and we sidestep the run-once migration
volume gotcha).
"""
import logging

import psycopg2.extras

from .db import get_conn, query, execute
from . import drug_data as dd
from . import drug_interactions as di

logger = logging.getLogger(__name__)

SCHEMA_SQL = """
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
"""


# ── Schema + seed ─────────────────────────────────────────────────────────────

def ensure_schema():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_SQL)
        conn.commit()
    finally:
        conn.close()


def seed_if_empty():
    """Populate curated tables from the built-in defaults, only when empty."""
    existing = query("SELECT COUNT(*) AS n FROM drugs")
    if existing and existing[0]["n"] > 0:
        return  # already seeded / admin-managed

    # Invert BRAND_TO_GENERIC -> {generic: [brands]}
    aliases_by_generic = {}
    for brand, generic in dd.BRAND_TO_GENERIC.items():
        aliases_by_generic.setdefault(generic, []).append(brand)

    drug_rows = [
        (g, classes, aliases_by_generic.get(g, []))
        for g, classes in dd.GENERIC_DRUGS.items()
    ]

    # Specific pairs -> sorted rows
    pair_rows = []
    for a, others in di.DRUG_INTERACTIONS.items():
        for b, rule in others.items():
            ga, gb = sorted([a, b])
            pair_rows.append((ga, gb, rule["severity"], rule["description"]))

    # Class rules -> rows (single-class key => class_a == class_b)
    class_rows = []
    for key, rule in di.CLASS_INTERACTIONS.items():
        ks = sorted(tuple(key))
        ca, cb = (ks[0], ks[0]) if len(ks) == 1 else (ks[0], ks[1])
        class_rows.append((ca, cb, rule["severity"], rule["description"]))

    allergy_rows = [(a, c) for a, c in di.ALLERGY_CLASS_MAP.items()]

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur, "INSERT INTO drugs (generic, classes, aliases) VALUES %s ON CONFLICT DO NOTHING",
                drug_rows)
            psycopg2.extras.execute_values(
                cur, "INSERT INTO drug_interactions (generic_a, generic_b, severity, description) VALUES %s ON CONFLICT DO NOTHING",
                pair_rows)
            psycopg2.extras.execute_values(
                cur, "INSERT INTO drug_class_interactions (class_a, class_b, severity, description) VALUES %s ON CONFLICT DO NOTHING",
                class_rows)
            psycopg2.extras.execute_values(
                cur, "INSERT INTO allergy_class_map (allergen, drug_class) VALUES %s ON CONFLICT DO NOTHING",
                allergy_rows)
        conn.commit()
        logger.info("[drug_repo] seeded %d drugs, %d pairs, %d class rules, %d allergy maps",
                    len(drug_rows), len(pair_rows), len(class_rows), len(allergy_rows))
    finally:
        conn.close()


def init():
    """Idempotent startup hook."""
    try:
        ensure_schema()
        seed_if_empty()
    except Exception:
        logger.exception("[drug_repo] init failed — falling back to in-code defaults")


# ── Load curated data into the rule-bundle shape the engine expects ───────────

def load_curated():
    """Return the rule bundle (same shape as drug_interactions.DEFAULT_RULES)
    sourced from the DB. Falls back to the built-in defaults on any error."""
    try:
        generics, brands = {}, {}
        for row in query("SELECT generic, classes, aliases FROM drugs"):
            generics[row["generic"]] = list(row["classes"] or [])
            for alias in (row["aliases"] or []):
                brands[alias] = row["generic"]

        pairs = {}
        for row in query("SELECT generic_a, generic_b, severity, description FROM drug_interactions"):
            pairs.setdefault(row["generic_a"], {})[row["generic_b"]] = {
                "severity": row["severity"], "description": row["description"]}

        class_interactions = {}
        for row in query("SELECT class_a, class_b, severity, description FROM drug_class_interactions"):
            key = frozenset({row["class_a"]}) if row["class_a"] == row["class_b"] else frozenset({row["class_a"], row["class_b"]})
            class_interactions[key] = {"severity": row["severity"], "description": row["description"]}

        allergy_map = {row["allergen"]: row["drug_class"]
                       for row in query("SELECT allergen, drug_class FROM allergy_class_map")}

        if not generics:
            return di.DEFAULT_RULES
        return {
            "generics": generics, "brands": brands,
            "class_interactions": class_interactions, "pairs": pairs,
            "allergy_map": allergy_map,
        }
    except Exception:
        logger.exception("[drug_repo] load_curated failed — using in-code defaults")
        return di.DEFAULT_RULES


# ── Curated CRUD (used by the HIS admin) ──────────────────────────────────────

def list_drugs():
    return query("SELECT id, generic, classes, aliases, source FROM drugs ORDER BY generic")


def upsert_drug(generic, classes, aliases, source="admin"):
    generic = (generic or "").strip().lower()
    return execute(
        """INSERT INTO drugs (generic, classes, aliases, source) VALUES (%s, %s, %s, %s)
           ON CONFLICT (generic) DO UPDATE SET classes = EXCLUDED.classes,
             aliases = EXCLUDED.aliases, updated_at = NOW()
           RETURNING id, generic, classes, aliases, source""",
        (generic, classes or [], aliases or [], source))


def delete_drug(generic):
    execute("DELETE FROM drugs WHERE generic = %s", ((generic or "").strip().lower(),))


def list_interactions():
    return query("SELECT id, generic_a, generic_b, severity, description, source FROM drug_interactions ORDER BY generic_a, generic_b")


def upsert_interaction(generic_a, generic_b, severity, description, source="admin"):
    a, b = sorted([(generic_a or "").strip().lower(), (generic_b or "").strip().lower()])
    return execute(
        """INSERT INTO drug_interactions (generic_a, generic_b, severity, description, source)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (generic_a, generic_b) DO UPDATE SET severity = EXCLUDED.severity,
             description = EXCLUDED.description, source = EXCLUDED.source
           RETURNING id""",
        (a, b, severity, description, source))


def delete_interaction(interaction_id):
    execute("DELETE FROM drug_interactions WHERE id = %s", (interaction_id,))


def list_class_interactions():
    return query("SELECT id, class_a, class_b, severity, description, source FROM drug_class_interactions ORDER BY class_a, class_b")


def upsert_class_interaction(class_a, class_b, severity, description, source="admin"):
    a, b = sorted([(class_a or "").strip().lower(), (class_b or "").strip().lower()])
    return execute(
        """INSERT INTO drug_class_interactions (class_a, class_b, severity, description, source)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (class_a, class_b) DO UPDATE SET severity = EXCLUDED.severity,
             description = EXCLUDED.description, source = EXCLUDED.source
           RETURNING id""",
        (a, b, severity, description, source))


def delete_class_interaction(row_id):
    execute("DELETE FROM drug_class_interactions WHERE id = %s", (row_id,))


def list_allergy_map():
    return query("SELECT id, allergen, drug_class FROM allergy_class_map ORDER BY allergen")


def upsert_allergy_map(allergen, drug_class):
    return execute(
        """INSERT INTO allergy_class_map (allergen, drug_class) VALUES (%s, %s)
           ON CONFLICT (allergen) DO UPDATE SET drug_class = EXCLUDED.drug_class RETURNING id""",
        ((allergen or "").strip().lower(), (drug_class or "").strip().lower()))


def delete_allergy_map(row_id):
    execute("DELETE FROM allergy_class_map WHERE id = %s", (row_id,))


# ── Review queue (the only place AI writes) ───────────────────────────────────

def enqueue_finding(unknown_drug, other_drug, severity, description, mechanism, confidence, model, session_id=None):
    """Upsert an AI finding for admin review. Re-checking the same pair updates the
    pending entry; once approved/dismissed it is left untouched."""
    a, b = sorted([(unknown_drug or "").strip().lower(), (other_drug or "").strip().lower()])
    execute(
        """INSERT INTO interaction_review_queue
             (unknown_drug, other_drug, ai_severity, ai_description, ai_mechanism, ai_confidence, model, session_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (unknown_drug, other_drug) DO UPDATE SET
             ai_severity = EXCLUDED.ai_severity, ai_description = EXCLUDED.ai_description,
             ai_mechanism = EXCLUDED.ai_mechanism, ai_confidence = EXCLUDED.ai_confidence,
             model = EXCLUDED.model, created_at = NOW()
           WHERE interaction_review_queue.status = 'pending'""",
        (a, b, severity, description, mechanism, confidence, model, session_id))


def list_queue(status="pending"):
    return query(
        "SELECT * FROM interaction_review_queue WHERE status = %s ORDER BY created_at DESC",
        (status,))


def dismiss(row_id):
    execute("UPDATE interaction_review_queue SET status = 'dismissed', reviewed_at = NOW() WHERE id = %s", (row_id,))


def approve(row_id, severity=None, description=None):
    """Promote a queued finding into the curated tables: ensure both drugs exist
    in `drugs` and write a curated `drug_interactions` row. Admin may override the
    severity/description before approving."""
    rows = query("SELECT * FROM interaction_review_queue WHERE id = %s", (row_id,))
    if not rows:
        return None
    item = rows[0]
    sev = severity or item["ai_severity"] or "warn"
    desc = description or item["ai_description"] or ""

    # Make sure the previously-unknown drug exists in the formulary (no classes yet —
    # admin can edit later). The 'other' drug is already curated.
    for g in (item["unknown_drug"], item["other_drug"]):
        execute("INSERT INTO drugs (generic, source) VALUES (%s, 'admin') ON CONFLICT (generic) DO NOTHING", (g,))

    upsert_interaction(item["unknown_drug"], item["other_drug"], sev, desc, source="admin")
    execute("UPDATE interaction_review_queue SET status = 'approved', reviewed_at = NOW() WHERE id = %s", (row_id,))
    return {"unknown_drug": item["unknown_drug"], "other_drug": item["other_drug"], "severity": sev}
