"""Tests for the class-based drug interaction engine (drug_interactions.py)."""
from src.drug_interactions import check_interactions, check_allergies, check_duplicates


def _severities(warnings):
    return {w["severity"] for w in warnings}


# ── Class-based blocks ────────────────────────────────────────────────────────

def test_ace_plus_arb_blocks():
    warns = check_interactions("enalapril", ["telmisartan"])
    assert any(w["severity"] == "block" for w in warns)


def test_beta_blocker_plus_nondhp_ccb_blocks():
    warns = check_interactions("metoprolol", ["verapamil"])
    assert any(w["severity"] == "block" for w in warns)


# ── Specific pair rules ───────────────────────────────────────────────────────

def test_clopidogrel_omeprazole_warns():
    warns = check_interactions("clopidogrel", ["omeprazole"])
    assert _severities(warns) == {"warn"}


def test_clopidogrel_pantoprazole_is_safe():
    # Pantoprazole is the recommended PPI with clopidogrel — no warning.
    assert check_interactions("clopidogrel", ["pantoprazole"]) == []


# ── No false positives ────────────────────────────────────────────────────────

def test_no_interaction_between_unrelated_drugs():
    assert check_interactions("paracetamol", ["amoxicillin"]) == []


# ── Brand names are normalised before checking ────────────────────────────────

def test_brand_names_are_checked():
    # Ecosprin (aspirin/antiplatelet) + warfarin (anticoagulant) → bleeding warn.
    warns = check_interactions("Ecosprin", ["warfarin"])
    assert any(w["severity"] == "warn" for w in warns)


def test_brand_class_block():
    # Metpure (metoprolol) + Dilzem (diltiazem) → beta-blocker + non-DHP CCB block.
    warns = check_interactions("Metpure 25", ["Dilzem 30"])
    assert any(w["severity"] == "block" for w in warns)


# ── Allergies (class-based) ───────────────────────────────────────────────────

def test_penicillin_allergy_blocks_amoxicillin_brand():
    warns = check_allergies("Augmentin 625", ["penicillin"])
    assert any(w["severity"] == "block" for w in warns)


def test_sulfa_allergy_blocks_furosemide_brand():
    warns = check_allergies("Lasix", ["sulfa"])
    assert any(w["severity"] == "block" for w in warns)


def test_no_allergy_false_positive():
    assert check_allergies("Dolo 650", ["penicillin"]) == []


# ── Duplicate detection ───────────────────────────────────────────────────────

def test_duplicate_brand_and_generic_flagged():
    warns = check_duplicates(["Ecosprin", "aspirin"])
    assert len(warns) == 1 and warns[0]["severity"] == "warn"


def test_distinct_drugs_not_flagged_as_duplicate():
    assert check_duplicates(["amlodipine", "telmisartan"]) == []
