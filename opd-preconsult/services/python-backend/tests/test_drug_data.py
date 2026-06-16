"""Tests for the drug formulary + brand→generic normalisation (drug_data.py)."""
import pytest

from src.drug_data import (
    normalize_drug_name,
    drug_classes,
    GENERIC_DRUGS,
    BRAND_TO_GENERIC,
)


@pytest.mark.parametrize("written,expected", [
    ("Crocin 500mg", "paracetamol"),
    ("Dolo 650", "paracetamol"),
    ("Augmentin 625", "amoxicillin"),
    ("Pan-D", "pantoprazole"),
    ("Ecosprin", "aspirin"),
    ("Telma 40", "telmisartan"),
    ("Glycomet 500", "metformin"),
    ("Tab. Atorva 10", "atorvastatin"),
    ("Shelcal CT", "calcium"),
])
def test_brand_to_generic(written, expected):
    assert normalize_drug_name(written) == expected


def test_known_generic_passes_through():
    assert normalize_drug_name("amoxicillin") == "amoxicillin"
    assert normalize_drug_name("Amoxicillin 500mg") == "amoxicillin"


def test_unknown_drug_is_cleaned_not_dropped():
    # Unknown names are returned cleaned (lowercased, dose stripped), never empty.
    assert normalize_drug_name("Wonderpill 200mg") == "wonderpill"
    assert normalize_drug_name("") == ""


def test_every_brand_maps_to_a_real_generic():
    """Guard against typos: every brand alias must resolve to a known generic."""
    missing = {b: g for b, g in BRAND_TO_GENERIC.items() if g not in GENERIC_DRUGS}
    assert not missing, f"Brands mapping to unknown generics: {missing}"


def test_drug_classes():
    assert "ace_inhibitor" in drug_classes("enalapril")
    assert "arb" in drug_classes("telmisartan")
    assert drug_classes("nonexistent-drug") == set()
