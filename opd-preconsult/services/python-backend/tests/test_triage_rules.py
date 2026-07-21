"""Triage rule set — the clinical safety core.

Triage decides who is seen first and who raises a nursing alert, and it is the one
part of the system that must provably never depend on a model. These tests pin the
rules themselves and, just as importantly, the MONOTONIC property: an automated
re-evaluation may escalate a patient but must never quietly downgrade one that a
safety tripwire already flagged.
"""
from src.routers.triage import evaluate_rules, _more_severe


# ── RED: symptom combinations ────────────────────────────────────────────────

def test_chest_pain_with_radiation_is_red():
    level, rules = evaluate_rules(
        {"q_chest_pain": "yes", "q_chest_pain_radiation": "yes"}, {})
    assert level == "RED"
    assert "chest_pain_with_radiation" in rules


def test_chest_pain_without_radiation_is_not_red():
    # Chest pain alone must not trip the radiation rule — the combination is what matters.
    level, rules = evaluate_rules(
        {"q_chest_pain": "yes", "q_chest_pain_radiation": "no"}, {})
    assert "chest_pain_with_radiation" not in rules
    assert level == "GREEN"


def test_syncope_with_chest_pain_is_red():
    level, rules = evaluate_rules({"q_syncope": "yes", "q_chest_pain": "yes"}, {})
    assert level == "RED"
    assert "syncope_with_chest_pain" in rules


def test_syncope_alone_is_only_amber():
    level, rules = evaluate_rules({"q_syncope": "yes"}, {})
    assert level == "AMBER"
    assert "syncope_alone" in rules


# ── RED: vitals thresholds, including the boundaries ─────────────────────────

def test_systolic_above_180_is_red():
    level, rules = evaluate_rules({}, {"bp_systolic": 181})
    assert level == "RED"
    assert "bp_systolic_critical" in rules


def test_systolic_exactly_180_is_amber_not_red():
    # The boundary matters clinically: >180 is critical, 160-180 is elevated.
    level, rules = evaluate_rules({}, {"bp_systolic": 180})
    assert level == "AMBER"
    assert "bp_systolic_elevated" in rules
    assert "bp_systolic_critical" not in rules


def test_systolic_exactly_160_is_amber():
    level, _ = evaluate_rules({}, {"bp_systolic": 160})
    assert level == "AMBER"


def test_systolic_159_is_green():
    level, _ = evaluate_rules({}, {"bp_systolic": 159})
    assert level == "GREEN"


def test_hypotension_is_red():
    # Shock is as critical as hypertensive crisis — a low reading must not read as normal.
    level, rules = evaluate_rules({}, {"bp_systolic": 85})
    assert level == "RED"
    assert "bp_systolic_hypotension" in rules


def test_systolic_exactly_90_is_not_hypotension():
    level, rules = evaluate_rules({}, {"bp_systolic": 90})
    assert "bp_systolic_hypotension" not in rules
    assert level == "GREEN"


def test_diastolic_above_120_is_red():
    level, rules = evaluate_rules({}, {"bp_diastolic": 121})
    assert level == "RED"
    assert "bp_diastolic_critical" in rules


def test_spo2_below_90_is_red():
    level, rules = evaluate_rules({}, {"spo2_pct": 89})
    assert level == "RED"
    assert "spo2_critical" in rules


def test_spo2_exactly_90_is_green():
    level, _ = evaluate_rules({}, {"spo2_pct": 90})
    assert level == "GREEN"


# ── Precedence and accumulation ──────────────────────────────────────────────

def test_red_suppresses_amber_rules():
    """A RED patient must not also be labelled AMBER — the level is the highest,
    and the AMBER block is skipped entirely once RED is set."""
    level, rules = evaluate_rules(
        {"q_syncope": "yes", "q_chest_pain": "yes", "q_breathlessness": "at_rest"}, {})
    assert level == "RED"
    assert "breathlessness_at_rest" not in rules
    assert "syncope_alone" not in rules


def test_multiple_red_rules_all_recorded():
    """Every triggered rule is reported, not just the first — the doctor should see
    the full picture, not one representative finding."""
    level, rules = evaluate_rules({}, {"bp_systolic": 200, "bp_diastolic": 130, "spo2_pct": 85})
    assert level == "RED"
    assert {"bp_systolic_critical", "bp_diastolic_critical", "spo2_critical"} <= set(rules)


def test_breathlessness_at_rest_is_amber():
    level, rules = evaluate_rules({"q_breathlessness": "at_rest"}, {})
    assert level == "AMBER"
    assert "breathlessness_at_rest" in rules


def test_breathlessness_on_exertion_is_not_amber():
    level, _ = evaluate_rules({"q_breathlessness": "on_exertion"}, {})
    assert level == "GREEN"


# ── Absent / partial data must never invent a level ──────────────────────────

def test_no_data_is_green():
    assert evaluate_rules({}, {}) == ("GREEN", [])


def test_missing_vitals_do_not_trigger_rules():
    """A patient who skipped vitals must come out GREEN on vitals grounds, not be
    misread as a critical reading."""
    level, rules = evaluate_rules({}, {"bp_systolic": None, "bp_diastolic": None, "spo2_pct": None})
    assert level == "GREEN"
    assert rules == []


def test_unrelated_answers_are_ignored():
    level, _ = evaluate_rules({"q_fever": "yes", "q_cough": "yes"}, {})
    assert level == "GREEN"


# ── The monotonic floor — never silently downgrade ───────────────────────────

def test_more_severe_prefers_the_higher_level():
    assert _more_severe("GREEN", "RED") == "RED"
    assert _more_severe("RED", "GREEN") == "RED"
    assert _more_severe("AMBER", "RED") == "RED"
    assert _more_severe("GREEN", "AMBER") == "AMBER"


def test_more_severe_is_stable_for_equal_levels():
    for lvl in ("GREEN", "AMBER", "RED"):
        assert _more_severe(lvl, lvl) == lvl


def test_monotonic_floor_preserves_a_prior_red():
    """The regression this guards: a patient flagged RED by a questionnaire tripwire,
    who then records normal vitals, must STAY RED. A downgrade here would remove them
    from the front of the queue after they had already been told they were urgent."""
    level, _ = evaluate_rules({}, {"bp_systolic": 120, "spo2_pct": 98})
    assert level == "GREEN"                      # the rules alone say GREEN
    assert _more_severe(level, "RED") == "RED"   # the floor keeps the prior RED


def test_unknown_prior_level_does_not_crash_or_escalate():
    assert _more_severe("AMBER", "UNKNOWN") == "AMBER"
