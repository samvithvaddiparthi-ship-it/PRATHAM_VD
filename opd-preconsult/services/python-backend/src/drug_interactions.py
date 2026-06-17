"""
Drug interaction checker for common Indian OPD drugs.

Two layers, both keyed off the shared vocabulary in drug_data.py:
  1. CLASS_INTERACTIONS — rules between drug CLASSES (e.g. any ACE-inhibitor +
     any ARB = block). Scales to the whole formulary without hand-listing pairs.
  2. DRUG_INTERACTIONS  — specific drug-pair rules for cases that aren't a clean
     class-vs-class rule (e.g. clopidogrel + omeprazole, levothyroxine + PPI).

Every drug name is run through normalize_drug_name() first, so brand names
written on a prescription (Ecosprin, Telma, Augmentin…) are checked correctly.

POC content — NOT exhaustive and NOT clinically validated. The rules below must
be reviewed by a clinician before any real-world reliance.
"""
from .drug_data import normalize_with, GENERIC_DRUGS, BRAND_TO_GENERIC

# ──────────────────────────────────────────────────────────────────────────────
# Class-vs-class rules.
# Key: frozenset of class names.
#   - 2 classes {a, b} -> fires when one drug is class a and the other is class b.
#   - 1 class  {a}     -> fires when BOTH drugs are class a (e.g. dual therapy).
# ──────────────────────────────────────────────────────────────────────────────
CLASS_INTERACTIONS = {
    frozenset({"ace_inhibitor", "arb"}):
        {"severity": "block", "description": "ACE inhibitor + ARB: increased renal failure and hyperkalemia risk. Avoid combination."},
    frozenset({"beta_blocker", "nondhp_ccb"}):
        {"severity": "block", "description": "Beta-blocker + non-DHP CCB (verapamil/diltiazem): severe bradycardia and heart-block risk."},

    frozenset({"ace_inhibitor", "k_sparing"}):
        {"severity": "warn", "description": "ACE inhibitor + potassium-sparing diuretic: hyperkalemia risk. Monitor potassium."},
    frozenset({"arb", "k_sparing"}):
        {"severity": "warn", "description": "ARB + potassium-sparing diuretic: hyperkalemia risk. Monitor potassium."},

    frozenset({"nsaid", "anticoagulant"}):
        {"severity": "warn", "description": "NSAID + anticoagulant: increased bleeding risk."},
    frozenset({"nsaid", "antiplatelet"}):
        {"severity": "warn", "description": "NSAID + antiplatelet: increased bleeding risk."},
    frozenset({"anticoagulant", "antiplatelet"}):
        {"severity": "warn", "description": "Anticoagulant + antiplatelet: increased bleeding risk. Monitor."},
    frozenset({"anticoagulant"}):
        {"severity": "warn", "description": "Two anticoagulants together: high bleeding risk. Avoid unless intended."},
    frozenset({"antiplatelet"}):
        {"severity": "warn", "description": "Dual antiplatelet therapy: increased bleeding risk. Confirm this is intended."},

    frozenset({"nsaid", "ace_inhibitor"}):
        {"severity": "warn", "description": "NSAID + ACE inhibitor: reduced BP control and renal impairment risk."},
    frozenset({"nsaid", "arb"}):
        {"severity": "warn", "description": "NSAID + ARB: reduced BP control and renal impairment risk."},
    frozenset({"nsaid", "loop_diuretic"}):
        {"severity": "warn", "description": "NSAID + diuretic: reduced diuretic effect and renal risk ('triple whammy' with ACE/ARB)."},
    frozenset({"nsaid", "corticosteroid"}):
        {"severity": "warn", "description": "NSAID + corticosteroid: increased GI ulceration and bleeding risk."},
    frozenset({"nsaid"}):
        {"severity": "warn", "description": "Two NSAIDs together: additive GI and renal toxicity. Avoid."},

    frozenset({"macrolide", "statin"}):
        {"severity": "warn", "description": "Macrolide (clarithromycin/erythromycin) + statin: rhabdomyolysis risk. Consider holding the statin."},
    frozenset({"nondhp_ccb", "statin"}):
        {"severity": "warn", "description": "Diltiazem/verapamil + statin: raised statin levels. Limit simvastatin/atorvastatin dose."},

    frozenset({"sulfonylurea", "insulin"}):
        {"severity": "warn", "description": "Sulfonylurea + insulin: additive hypoglycemia risk. Monitor blood glucose."},
    frozenset({"sulfonylurea"}):
        {"severity": "warn", "description": "Two sulfonylureas together: hypoglycemia risk. Avoid duplication."},

    frozenset({"loop_diuretic", "cardiac_glycoside"}):
        {"severity": "warn", "description": "Loop diuretic-induced hypokalemia increases digoxin toxicity risk. Monitor potassium."},
    frozenset({"thiazide", "cardiac_glycoside"}):
        {"severity": "warn", "description": "Thiazide-induced hypokalemia increases digoxin toxicity risk. Monitor potassium."},

    frozenset({"fluoroquinolone", "corticosteroid"}):
        {"severity": "warn", "description": "Fluoroquinolone + corticosteroid: increased tendon rupture risk."},

    frozenset({"benzodiazepine", "opioid"}):
        {"severity": "warn", "description": "Benzodiazepine + opioid: additive sedation and respiratory depression. Avoid if possible."},

    frozenset({"ssri", "nsaid"}):
        {"severity": "warn", "description": "SSRI + NSAID: increased GI bleeding risk."},
    frozenset({"ssri", "anticoagulant"}):
        {"severity": "warn", "description": "SSRI + anticoagulant: increased bleeding risk."},
    frozenset({"ssri", "antiplatelet"}):
        {"severity": "warn", "description": "SSRI + antiplatelet: increased bleeding risk."},
    frozenset({"ssri", "tca"}):
        {"severity": "warn", "description": "SSRI + tricyclic: serotonin toxicity and raised TCA levels. Use caution."},

    frozenset({"macrolide", "antiarrhythmic"}):
        {"severity": "warn", "description": "Macrolide + amiodarone: additive QT prolongation. Monitor ECG."},
    frozenset({"fluoroquinolone", "antiarrhythmic"}):
        {"severity": "warn", "description": "Fluoroquinolone + amiodarone: additive QT prolongation. Monitor ECG."},
    frozenset({"macrolide", "fluoroquinolone"}):
        {"severity": "warn", "description": "Two QT-prolonging antibiotics together: additive QT prolongation risk."},
}

# ──────────────────────────────────────────────────────────────────────────────
# Specific drug-pair rules (generic names). Used in addition to class rules; a
# specific rule takes precedence over any class rule for the same pair.
# Format: {drug_a: {drug_b: {severity, description}}}
# ──────────────────────────────────────────────────────────────────────────────
DRUG_INTERACTIONS = {
    "warfarin": {
        "amiodarone": {"severity": "warn", "description": "Amiodarone increases warfarin levels. Reduce warfarin dose and monitor INR."},
        "metronidazole": {"severity": "warn", "description": "Metronidazole increases warfarin effect. Monitor INR."},
        "ciprofloxacin": {"severity": "warn", "description": "Ciprofloxacin increases warfarin effect. Monitor INR."},
        "levothyroxine": {"severity": "warn", "description": "Levothyroxine can increase warfarin effect. Monitor INR."},
    },
    "digoxin": {
        "amiodarone": {"severity": "warn", "description": "Amiodarone increases digoxin levels. Reduce digoxin dose by ~50%."},
        "verapamil": {"severity": "warn", "description": "Verapamil increases digoxin levels and risk of bradycardia."},
    },
    "clopidogrel": {
        "omeprazole": {"severity": "warn", "description": "Omeprazole reduces clopidogrel efficacy. Use pantoprazole instead."},
        "esomeprazole": {"severity": "warn", "description": "Esomeprazole reduces clopidogrel efficacy. Use pantoprazole instead."},
    },
    "ticagrelor": {
        "aspirin": {"severity": "warn", "description": "Use low-dose aspirin only (75-100mg); higher doses reduce ticagrelor efficacy."},
    },
    "levothyroxine": {
        "pantoprazole": {"severity": "warn", "description": "PPIs reduce levothyroxine absorption. Separate doses by ~4 hours."},
        "omeprazole": {"severity": "warn", "description": "PPIs reduce levothyroxine absorption. Separate doses by ~4 hours."},
        "rabeprazole": {"severity": "warn", "description": "PPIs reduce levothyroxine absorption. Separate doses by ~4 hours."},
        "esomeprazole": {"severity": "warn", "description": "PPIs reduce levothyroxine absorption. Separate doses by ~4 hours."},
        "calcium": {"severity": "warn", "description": "Calcium reduces levothyroxine absorption. Separate doses by ~4 hours."},
        "ferrous_sulfate": {"severity": "warn", "description": "Iron reduces levothyroxine absorption. Separate doses by ~4 hours."},
    },
    "simvastatin": {
        "amiodarone": {"severity": "warn", "description": "Limit simvastatin to 20mg/day with amiodarone. Rhabdomyolysis risk."},
    },
}

# Allergy term -> the drug class it contraindicates. Plus direct generic matches.
ALLERGY_CLASS_MAP = {
    "sulfa": "sulfonamide",
    "sulfonamide": "sulfonamide",
    "sulpha": "sulfonamide",
    "penicillin": "penicillin",
    "nsaid": "nsaid",
    "nsaids": "nsaid",
    "aspirin": "nsaid",
    "ace inhibitor": "ace_inhibitor",
    "ace-inhibitor": "ace_inhibitor",
    "statin": "statin",
    "beta blocker": "beta_blocker",
    "beta-blocker": "beta_blocker",
    "macrolide": "macrolide",
    "cephalosporin": "cephalosporin",
    "fluoroquinolone": "fluoroquinolone",
    "quinolone": "fluoroquinolone",
}


# Bundle of the rule data the check functions operate on. The built-in module
# dicts are the DEFAULT (used by tests and as the seed); the live app passes a
# DB-backed bundle of the same shape from drug_repo.load_curated().
DEFAULT_RULES = {
    "generics": GENERIC_DRUGS,
    "brands": BRAND_TO_GENERIC,
    "class_interactions": CLASS_INTERACTIONS,
    "pairs": DRUG_INTERACTIONS,
    "allergy_map": ALLERGY_CLASS_MAP,
}


def _norm(name, rules):
    return normalize_with(name, rules["generics"], rules["brands"])


def _classes(generic, rules):
    return set(rules["generics"].get((generic or "").lower(), []))


def _class_rule_for(classes_a: set, classes_b: set, class_interactions):
    """Best (most severe) class rule between two class sets, or None."""
    best = None
    for key, rule in class_interactions.items():
        if len(key) == 1:
            (c,) = tuple(key)
            hit = c in classes_a and c in classes_b
        else:
            c1, c2 = tuple(key)
            hit = (c1 in classes_a and c2 in classes_b) or (c2 in classes_a and c1 in classes_b)
        if hit:
            if best is None or (rule["severity"] == "block" and best["severity"] != "block"):
                best = rule
    return best


def _specific_rule_for(generic_a: str, generic_b: str, pairs):
    """Specific drug-pair rule (either direction), or None."""
    if generic_a in pairs and generic_b in pairs[generic_a]:
        return pairs[generic_a][generic_b]
    if generic_b in pairs and generic_a in pairs[generic_b]:
        return pairs[generic_b][generic_a]
    return None


def check_interactions(drug_name, other_drugs, rules=None):
    """Check a drug against a list of other drugs. Returns a list of warnings.
    Output shape is unchanged: {drug_a, drug_b, severity, description} using the
    original names as written (for display). `rules` defaults to the built-ins."""
    rules = rules or DEFAULT_RULES
    warnings = []
    generic = _norm(drug_name, rules)
    classes_a = _classes(generic, rules)

    for other in other_drugs:
        other_generic = _norm(other, rules)
        if generic == other_generic:
            continue

        # Specific pair rule wins; otherwise fall back to class rule.
        rule = _specific_rule_for(generic, other_generic, rules["pairs"])
        if rule is None:
            rule = _class_rule_for(classes_a, _classes(other_generic, rules), rules["class_interactions"])

        if rule:
            warnings.append({
                "drug_a": drug_name,
                "drug_b": other,
                "severity": rule["severity"],
                "description": rule["description"],
            })

    return warnings


def check_duplicates(drugs, rules=None):
    """Flag the same active drug prescribed more than once (e.g. a brand and its
    generic, or a drug repeated). Returns warnings in the same shape as
    check_interactions so the frontend renders them identically."""
    rules = rules or DEFAULT_RULES
    warnings = []
    seen = {}
    for name in drugs:
        generic = _norm(name, rules)
        if not generic:
            continue
        if generic in seen:
            warnings.append({
                "drug_a": seen[generic],
                "drug_b": name,
                "severity": "warn",
                "description": f"Same drug prescribed twice ({generic}). Confirm this duplication is intended.",
            })
        else:
            seen[generic] = name
    return warnings


def check_allergies(drug_name, allergies, rules=None):
    """Check a drug against patient allergies. Returns a list of contraindications.
    Output shape unchanged: {drug, allergy, severity, description}."""
    rules = rules or DEFAULT_RULES
    warnings = []
    generic = _norm(drug_name, rules)
    classes = _classes(generic, rules)

    for allergy in allergies:
        allergy_lower = (allergy or "").lower().strip()
        if not allergy_lower:
            continue

        # Direct match against the generic (also matches if the allergy itself is
        # a brand name, since both sides are normalized).
        if allergy_lower == generic or _norm(allergy_lower, rules) == generic:
            warnings.append({
                "drug": drug_name,
                "allergy": allergy,
                "severity": "block",
                "description": f"Patient has a documented allergy to {allergy}. Do NOT prescribe {drug_name}.",
            })
            continue

        # Class-based match.
        cls = rules["allergy_map"].get(allergy_lower)
        if cls and cls in classes:
            warnings.append({
                "drug": drug_name,
                "allergy": allergy,
                "severity": "block",
                "description": f"Patient has a {allergy} allergy. {drug_name} is contraindicated.",
            })

    return warnings


def is_known(drug_name, rules=None):
    """True if the drug normalizes to a generic that exists in the formulary."""
    rules = rules or DEFAULT_RULES
    return _norm(drug_name, rules) in rules["generics"]
