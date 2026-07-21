"""Bhashini Stage-2 transcript correction.

The patient's own words are the one thing in the system that must not be rewritten,
so these tests pin the guarantees rather than the wording: numbers and doses survive
untouched, the deterministic passes do what they claim, and the patient's name is
only substituted where a name could plausibly have been spoken.

All of these exercise the rule-based path (no model), so they run without an API key
and without a network — which is also what makes them a usable regression net.
"""
from src.bhashini.medcorrect import (
    apply_lexicon, collapse_repeats, apply_name, verify_numbers,
    protected_values, _is_word_level_edit,
)


# ── Lexicon: orthography and canonical names only ────────────────────────────

def test_hindi_orthography_normalised():
    out, changes = apply_lexicon("मुझे जांच करानी है", "hi")
    assert "जाँच" in out
    assert changes


def test_telugu_compound_spacing_normalised():
    out, _ = apply_lexicon("నాకు రక్త పోటు ఉంది", "te")
    assert "రక్తపోటు" in out


def test_english_medical_terms_are_cased_not_translated():
    out, _ = apply_lexicon("ecg and bp were done", "en")
    assert "ECG" in out and "BP" in out


def test_drug_names_are_canonicalised():
    out, _ = apply_lexicon("i take dolo and paracetamol", "en")
    assert "Dolo" in out and "Paracetamol" in out


def test_english_terms_survive_inside_indic_speech():
    """Code-switching is the norm in an Indian OPD — an English clinical word inside
    a Hindi sentence must be kept in English, never translated."""
    out, _ = apply_lexicon("मुझे fever है", "hi")
    assert "fever" in out.lower()
    assert "मुझे" in out


def test_lexicon_leaves_unknown_text_alone():
    src = "मुझे सिर में हल्का दर्द है"
    out, changes = apply_lexicon(src, "hi")
    assert out == src
    assert changes == []


# ── De-stuttering: function words only ───────────────────────────────────────

def test_repeated_function_word_is_collapsed():
    out, changes = collapse_repeats("मैं मैं मैं ठीक हूँ", "hi")
    assert out.count("मैं") == 1
    assert changes


def test_repeated_clinical_word_is_preserved():
    """'pain pain' may be emphasis, not a stutter. Collapsing clinical content
    would change what the patient reported."""
    out, _ = collapse_repeats("pain pain in chest", "en")
    assert out.count("pain") == 2


# ── Name matching: only after an explicit cue ────────────────────────────────

def test_name_snapped_after_an_english_cue():
    out, changes = apply_name("my name is ramesh", "Ramesh", "en")
    assert "Ramesh" in out
    assert changes


def test_name_snapped_after_a_hindi_cue():
    out, _ = apply_name("मेरा नाम रमेश है", "रमेश", "hi")
    assert "रमेश" in out


def test_similar_word_without_a_cue_is_left_alone():
    """The rule that keeps this safe: a clinical word that merely rhymes with the
    patient's name must not be rewritten into the name."""
    out, changes = apply_name("i have a rash on my arm", "Rash", "en")
    assert "rash" in out.lower()
    assert changes == []


def test_no_registered_name_is_a_no_op():
    out, changes = apply_name("my name is ramesh", "", "en")
    assert out == "my name is ramesh"
    assert changes == []


# ── Numbers and doses are never silently altered ─────────────────────────────

def test_doses_are_protected_values():
    protected = protected_values("take dolo 650 twice and 5 mg at night")
    joined = " ".join(protected)
    assert "650" in joined and "5" in joined


def test_changed_number_is_flagged():
    """If a dose moves between the raw and corrected transcript, it must surface as
    uncertain rather than be accepted — a silently altered dose is a prescribing risk."""
    flagged = verify_numbers("dolo 650", "dolo 500", [])
    assert flagged, "a changed dose must be reported as uncertain"


def test_unchanged_numbers_are_not_flagged():
    assert verify_numbers("dolo 650 twice", "Dolo 650 twice", []) == []


def test_bp_reading_survives_correction():
    out, _ = apply_lexicon("bp is 140 by 90 and sugar 210 mg/dl", "en")
    for value in ("140", "90", "210"):
        assert value in out


# ── The anti-paraphrase guardrail on the model's output ──────────────────────

def test_word_level_substitution_is_accepted():
    assert _is_word_level_edit("मुझे नपु है", "मुझे नोप्पि है")


def test_wholesale_rewrite_is_rejected():
    """The guardrail that stops the model restating the patient rather than
    correcting it."""
    assert not _is_word_level_edit(
        "i have had a bad headache since yesterday morning",
        "patient reports cephalalgia of one day duration with no associated aura",
    )


def test_large_insertion_is_rejected():
    assert not _is_word_level_edit(
        "chest pain",
        "chest pain radiating to the left arm with sweating and nausea",
    )
