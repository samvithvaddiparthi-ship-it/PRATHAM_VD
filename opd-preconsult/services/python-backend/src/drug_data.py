"""
Single source of truth for drug knowledge used across the backend:

- GENERIC_DRUGS  : curated common-OPD formulary (generic name -> drug classes).
- BRAND_TO_GENERIC : Indian brand / local name -> generic name.
- normalize_drug_name() : turn anything written on a prescription (brand name,
  with or without a trailing dose) into its formal generic name.
- drug_classes() : the pharmacological classes of a generic drug.

Both the OCR pipeline (brand -> formal name on uploaded prescriptions) and the
drug-interaction engine import from here, so the app has ONE drug vocabulary
instead of three drifting copies.

POC content — NOT a complete formulary and NOT clinically validated. The class
tags and brand map should be reviewed by a clinician before any real use.
"""
import re
import difflib

# Fuzzy-match tuning (see _fuzzy_match). Conservative on purpose — this is a
# clinical-safety path, so we only accept a very close single best match and never
# fuzz short tokens (which collide easily). 0.86 catches OCR typos like
# "amoxillin"->"amoxicillin" / "metaprolol"->"metoprolol" while rejecting genuinely
# different drugs. Tunable via env without a code change.
import os as _os
_FUZZY_CUTOFF = float(_os.getenv("DRUG_FUZZY_CUTOFF", "0.86"))
_FUZZY_MIN_LEN = int(_os.getenv("DRUG_FUZZY_MIN_LEN", "6"))

# ──────────────────────────────────────────────────────────────────────────────
# Generic formulary: generic name -> list of pharmacological classes.
# Classes drive the interaction engine (see drug_interactions.py). A drug may
# belong to several classes.
# ──────────────────────────────────────────────────────────────────────────────
GENERIC_DRUGS = {
    # ── Anticoagulants / antiplatelets ───────────────────────────────────────
    "warfarin":        ["anticoagulant"],
    "acenocoumarol":   ["anticoagulant"],
    "rivaroxaban":     ["anticoagulant"],
    "apixaban":        ["anticoagulant"],
    "dabigatran":      ["anticoagulant"],
    "heparin":         ["anticoagulant"],
    "enoxaparin":      ["anticoagulant"],
    "aspirin":         ["antiplatelet", "nsaid"],
    "clopidogrel":     ["antiplatelet"],
    "ticagrelor":      ["antiplatelet"],
    "prasugrel":       ["antiplatelet"],

    # ── Beta-blockers ─────────────────────────────────────────────────────────
    "metoprolol":      ["beta_blocker"],
    "atenolol":        ["beta_blocker"],
    "propranolol":     ["beta_blocker"],
    "carvedilol":      ["beta_blocker"],
    "bisoprolol":      ["beta_blocker"],
    "nebivolol":       ["beta_blocker"],

    # ── Calcium channel blockers ──────────────────────────────────────────────
    "amlodipine":      ["dhp_ccb"],
    "nifedipine":      ["dhp_ccb"],
    "cilnidipine":     ["dhp_ccb"],
    "diltiazem":       ["nondhp_ccb"],
    "verapamil":       ["nondhp_ccb"],

    # ── ACE inhibitors ────────────────────────────────────────────────────────
    "enalapril":       ["ace_inhibitor"],
    "ramipril":        ["ace_inhibitor"],
    "lisinopril":      ["ace_inhibitor"],
    "perindopril":     ["ace_inhibitor"],

    # ── ARBs ──────────────────────────────────────────────────────────────────
    "telmisartan":     ["arb"],
    "losartan":        ["arb"],
    "olmesartan":      ["arb"],
    "valsartan":       ["arb"],

    # ── Diuretics ─────────────────────────────────────────────────────────────
    "furosemide":          ["loop_diuretic", "sulfonamide"],
    "torsemide":           ["loop_diuretic", "sulfonamide"],
    "spironolactone":      ["k_sparing"],
    "hydrochlorothiazide": ["thiazide", "sulfonamide"],
    "chlorthalidone":      ["thiazide", "sulfonamide"],
    "indapamide":          ["thiazide", "sulfonamide"],

    # ── Lipid-lowering ────────────────────────────────────────────────────────
    "atorvastatin":    ["statin"],
    "rosuvastatin":    ["statin"],
    "simvastatin":     ["statin"],
    "fenofibrate":     ["fibrate"],
    "ezetimibe":       ["lipid_lowering"],

    # ── Diabetes ──────────────────────────────────────────────────────────────
    "metformin":       ["biguanide"],
    "glipizide":       ["sulfonylurea"],
    "glimepiride":     ["sulfonylurea"],
    "gliclazide":      ["sulfonylurea"],
    "sitagliptin":     ["dpp4"],
    "vildagliptin":    ["dpp4"],
    "linagliptin":     ["dpp4"],
    "teneligliptin":   ["dpp4"],
    "empagliflozin":   ["sglt2"],
    "dapagliflozin":   ["sglt2"],
    "canagliflozin":   ["sglt2"],
    "pioglitazone":    ["thiazolidinedione"],
    "insulin":         ["insulin"],
    "acarbose":        ["alpha_glucosidase"],

    # ── Cardiac (other) ───────────────────────────────────────────────────────
    "digoxin":         ["cardiac_glycoside"],
    "amiodarone":      ["antiarrhythmic"],
    "ivabradine":      ["antianginal"],
    "nitroglycerin":   ["nitrate"],
    "isosorbide":      ["nitrate"],

    # ── GI / PPIs / antacids / antiemetics ────────────────────────────────────
    "pantoprazole":    ["ppi"],
    "omeprazole":      ["ppi"],
    "rabeprazole":     ["ppi"],
    "esomeprazole":    ["ppi"],
    "ranitidine":      ["h2_blocker"],
    "famotidine":      ["h2_blocker"],
    "domperidone":     ["prokinetic"],
    "ondansetron":     ["antiemetic"],
    "metoclopramide":  ["prokinetic"],
    "sucralfate":      ["mucosal_protectant"],
    "dicyclomine":     ["antispasmodic"],

    # ── Analgesics / antipyretics / NSAIDs ────────────────────────────────────
    "paracetamol":     ["analgesic", "antipyretic"],
    "ibuprofen":       ["nsaid"],
    "diclofenac":      ["nsaid"],
    "naproxen":        ["nsaid"],
    "aceclofenac":     ["nsaid"],
    "etoricoxib":      ["nsaid"],
    "ketorolac":       ["nsaid"],
    "nimesulide":      ["nsaid"],
    "mefenamic":       ["nsaid"],
    "tramadol":        ["opioid"],
    "serratiopeptidase": ["enzyme"],

    # ── Thyroid ───────────────────────────────────────────────────────────────
    "levothyroxine":   ["thyroid"],
    "carbimazole":     ["antithyroid"],

    # ── Corticosteroids ───────────────────────────────────────────────────────
    "prednisolone":        ["corticosteroid"],
    "dexamethasone":       ["corticosteroid"],
    "methylprednisolone":  ["corticosteroid"],
    "hydrocortisone":      ["corticosteroid"],
    "deflazacort":         ["corticosteroid"],

    # ── Antibiotics ───────────────────────────────────────────────────────────
    "azithromycin":    ["macrolide"],
    "clarithromycin":  ["macrolide"],
    "erythromycin":    ["macrolide"],
    "amoxicillin":     ["penicillin"],
    "ampicillin":      ["penicillin"],
    "cloxacillin":     ["penicillin"],
    "ciprofloxacin":   ["fluoroquinolone"],
    "levofloxacin":    ["fluoroquinolone"],
    "ofloxacin":       ["fluoroquinolone"],
    "norfloxacin":     ["fluoroquinolone"],
    "ceftriaxone":     ["cephalosporin"],
    "cefixime":        ["cephalosporin"],
    "cefuroxime":      ["cephalosporin"],
    "cephalexin":      ["cephalosporin"],
    "doxycycline":     ["tetracycline"],
    "metronidazole":   ["nitroimidazole"],
    "ornidazole":      ["nitroimidazole"],
    "clindamycin":     ["lincosamide"],
    "cotrimoxazole":   ["sulfonamide", "antibiotic"],
    "nitrofurantoin":  ["antibiotic"],

    # ── Respiratory ───────────────────────────────────────────────────────────
    "montelukast":     ["leukotriene_antagonist"],
    "salbutamol":      ["saba"],
    "levosalbutamol":  ["saba"],
    "budesonide":      ["inhaled_corticosteroid"],
    "formoterol":      ["laba"],
    "theophylline":    ["xanthine"],
    "ambroxol":        ["mucolytic"],
    "guaifenesin":     ["expectorant"],

    # ── Antihistamines / allergy ──────────────────────────────────────────────
    "cetirizine":      ["antihistamine"],
    "levocetirizine":  ["antihistamine"],
    "fexofenadine":    ["antihistamine"],
    "loratadine":      ["antihistamine"],
    "chlorpheniramine": ["antihistamine"],
    "hydroxyzine":     ["antihistamine"],

    # ── Neuro / psych ─────────────────────────────────────────────────────────
    "amitriptyline":   ["tca"],
    "gabapentin":      ["anticonvulsant"],
    "pregabalin":      ["anticonvulsant"],
    "clonazepam":      ["benzodiazepine"],
    "alprazolam":      ["benzodiazepine"],
    "escitalopram":    ["ssri"],
    "sertraline":      ["ssri"],

    # ── Supplements / misc ────────────────────────────────────────────────────
    "calcium":         ["supplement"],
    "vitamin_d3":      ["supplement"],
    "cholecalciferol": ["supplement"],
    "vitamin_b12":     ["supplement"],
    "methylcobalamin": ["supplement"],
    "folic_acid":      ["supplement"],
    "ferrous_sulfate": ["supplement"],
    "ors":             ["supplement"],
    "zinc":            ["supplement"],
}


# ──────────────────────────────────────────────────────────────────────────────
# Indian brand / local name -> generic. Keys are lowercase, no dose.
# Combination brands map to their PRIMARY active ingredient (noted inline);
# interaction checking still works off that primary active.
# ──────────────────────────────────────────────────────────────────────────────
BRAND_TO_GENERIC = {
    # Paracetamol
    "crocin": "paracetamol", "dolo": "paracetamol", "calpol": "paracetamol",
    "pacimol": "paracetamol", "pyrigesic": "paracetamol", "p-250": "paracetamol",
    "metacin": "paracetamol", "febrinil": "paracetamol",
    # Aspirin
    "ecosprin": "aspirin", "disprin": "aspirin", "aspicot": "aspirin",
    "loprin": "aspirin",
    # NSAIDs
    "combiflam": "ibuprofen",          # combo: ibuprofen + paracetamol
    "brufen": "ibuprofen", "ibugesic": "ibuprofen",
    "voveran": "diclofenac", "voltaren": "diclofenac", "diclomol": "diclofenac",
    "dynapar": "diclofenac",
    "zerodol": "aceclofenac", "hifenac": "aceclofenac",
    "nise": "nimesulide", "nimulid": "nimesulide",
    "etoshine": "etoricoxib", "nucoxia": "etoricoxib",
    # PPIs / GI
    "pan": "pantoprazole", "pan-d": "pantoprazole", "pantop": "pantoprazole",
    "pantocid": "pantoprazole", "pantodac": "pantoprazole",
    "omez": "omeprazole", "ocid": "omeprazole",
    "razo": "rabeprazole", "rabicip": "rabeprazole", "rabium": "rabeprazole",
    "nexpro": "esomeprazole", "esoz": "esomeprazole",
    "rantac": "ranitidine", "aciloc": "ranitidine", "zinetac": "ranitidine",
    "famocid": "famotidine",
    "domstal": "domperidone",
    "emeset": "ondansetron", "vomikind": "ondansetron", "ondem": "ondansetron",
    "perinorm": "metoclopramide",
    "cyclopam": "dicyclomine",        # combo: dicyclomine + paracetamol
    "meftal": "mefenamic", "meftal-spas": "mefenamic",   # combo: mefenamic + dicyclomine
    # Antibiotics
    "augmentin": "amoxicillin",       # combo: amoxicillin + clavulanate
    "clavam": "amoxicillin", "moxikind": "amoxicillin", "mox": "amoxicillin",
    "novamox": "amoxicillin",
    "azithral": "azithromycin", "azee": "azithromycin", "zithromax": "azithromycin",
    "clarithro": "clarithromycin",
    "cifran": "ciprofloxacin", "ciplox": "ciprofloxacin", "cipro": "ciprofloxacin",
    "levoflox": "levofloxacin", "levomac": "levofloxacin", "tavanic": "levofloxacin",
    "oflox": "ofloxacin",
    "monocef": "ceftriaxone",
    "taxim": "cefixime", "taxim-o": "cefixime", "zifi": "cefixime", "cefix": "cefixime",
    "ceftum": "cefuroxime",
    "doxt": "doxycycline", "doxy": "doxycycline",
    "flagyl": "metronidazole", "metrogyl": "metronidazole",
    "dazomet": "ornidazole",
    "septran": "cotrimoxazole", "bactrim": "cotrimoxazole",
    # Cardiac / BP
    "telma": "telmisartan", "telsar": "telmisartan", "telvas": "telmisartan",
    "losar": "losartan", "repace": "losartan",
    "olmy": "olmesartan", "olmesar": "olmesartan",
    "valzaar": "valsartan",
    "stamlo": "amlodipine", "amlong": "amlodipine", "amlokind": "amlodipine",
    "amlovas": "amlodipine",
    "cardace": "ramipril", "ramistar": "ramipril",
    "envas": "enalapril",
    "metpure": "metoprolol", "metolar": "metoprolol", "betaloc": "metoprolol",
    "ziblok": "atenolol", "aten": "atenolol", "tenormin": "atenolol",
    "concor": "bisoprolol",
    "cardivas": "carvedilol",
    "dilzem": "diltiazem",
    "isordil": "isosorbide", "sorbitrate": "isosorbide",
    "lanoxin": "digoxin",
    "cordarone": "amiodarone",
    "lasix": "furosemide", "frusenex": "furosemide",
    "aldactone": "spironolactone",
    # Statins
    "atorva": "atorvastatin", "atorfit": "atorvastatin", "storvas": "atorvastatin",
    "lipitor": "atorvastatin", "atorlip": "atorvastatin",
    "rosuvas": "rosuvastatin", "rozavel": "rosuvastatin", "crestor": "rosuvastatin",
    "rozucor": "rosuvastatin",
    # Diabetes
    "glycomet": "metformin", "gluconorm": "metformin", "obimet": "metformin",
    "glyciphage": "metformin",
    "amaryl": "glimepiride", "glimestar": "glimepiride", "glimy": "glimepiride",
    "glynase": "glipizide",
    "diamicron": "gliclazide", "glizid": "gliclazide",
    "januvia": "sitagliptin", "istavel": "sitagliptin",
    "galvus": "vildagliptin",
    "jardiance": "empagliflozin",
    "forxiga": "dapagliflozin", "dapa": "dapagliflozin",
    "pioz": "pioglitazone",
    # Thyroid
    "thyronorm": "levothyroxine", "eltroxin": "levothyroxine", "thyrox": "levothyroxine",
    "neomercazole": "carbimazole",
    # Steroids
    "wysolone": "prednisolone", "omnacortil": "prednisolone",
    "dexona": "dexamethasone",
    "medrol": "methylprednisolone",
    # Respiratory / allergy
    "montair": "montelukast", "montek": "montelukast",
    "asthalin": "salbutamol", "ventorlin": "salbutamol",
    "levolin": "levosalbutamol",
    "budecort": "budesonide", "foracort": "budesonide",
    "deriphyllin": "theophylline",
    "ambrodil": "ambroxol",
    "cetzine": "cetirizine", "alerid": "cetirizine", "cetcip": "cetirizine",
    "levocet": "levocetirizine", "xyzal": "levocetirizine",
    "allegra": "fexofenadine", "fexova": "fexofenadine",
    "avil": "chlorpheniramine",
    "atarax": "hydroxyzine",
    # Neuro / psych / pain
    "ultracet": "tramadol",           # combo: tramadol + paracetamol
    "gabapin": "gabapentin",
    "pregaba": "pregabalin", "lyrica": "pregabalin", "nervmax": "pregabalin",
    "clonotril": "clonazepam",
    "alprax": "alprazolam", "restyl": "alprazolam",
    "nexito": "escitalopram", "cipralex": "escitalopram",
    "zoloft": "sertraline",
    "amitone": "amitriptyline",
    # Supplements
    "shelcal": "calcium", "calcimax": "calcium", "gemcal": "calcium",
    "uprise-d3": "cholecalciferol", "calcirol": "cholecalciferol", "d-rise": "cholecalciferol",
    "neurobion": "methylcobalamin", "nurokind": "methylcobalamin",
    "folvite": "folic_acid",
    "orofer": "ferrous_sulfate", "dexorange": "ferrous_sulfate", "livogen": "ferrous_sulfate",
    "zincovit": "zinc", "becosules": "vitamin_b12",
}


# Trailing words/qualifiers to strip before matching (dose forms, units).
_QUALIFIER_RE = re.compile(
    r"\b("
    r"\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|ml|iu|units?)|"   # 500mg, 5 ml, 100 IU
    r"tab(?:let)?s?|cap(?:sule)?s?|syr(?:up)?|inj(?:ection)?|"
    r"susp(?:ension)?|drops?|cream|ointment|gel|oral|po|"
    r"od|bd|tds|qid|hs|sos|prn"
    r")\b",
    re.IGNORECASE,
)
_PUNCT_RE = re.compile(r"[^a-z0-9\s\-]")


def _clean(name: str) -> str:
    """Lowercase, drop dose/form qualifiers and stray punctuation, collapse spaces."""
    s = (name or "").lower().strip()
    s = _QUALIFIER_RE.sub(" ", s)
    s = _PUNCT_RE.sub(" ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _fuzzy_match(token: str, generics, brands):
    """Last-resort near-match for OCR/spelling errors. Returns the mapped generic
    for the single closest formulary entry within _FUZZY_CUTOFF, or None. Guarded
    by a minimum length so short tokens (which fuzzy-collide easily) never match.

    This is what lets a misread "amoxillin" still be checked as amoxicillin for
    interactions/allergies instead of silently passing through as an unknown drug.
    """
    if len(token) < _FUZZY_MIN_LEN:
        return None
    # Candidates: every generic name + every brand alias.
    candidates = list(generics) + list(brands)
    hits = difflib.get_close_matches(token, candidates, n=1, cutoff=_FUZZY_CUTOFF)
    if not hits:
        return None
    hit = hits[0]
    return brands[hit] if hit in brands else hit


def normalize_with(name: str, generics, brands) -> str:
    """Data-driven normalisation: match a written drug name against the provided
    `generics` (iterable/set of generic names) and `brands` (brand->generic map).
    Lets the DB-backed formulary feed the same logic as the built-in defaults.
    Returns the cleaned original if no match (unknown drugs pass through)."""
    cleaned = _clean(name)
    if not cleaned:
        return (name or "").strip()

    if cleaned in generics:
        return cleaned
    if cleaned in brands:
        return brands[cleaned]

    # First token (handles "telma 40", "augmentin 625", "shelcal ct").
    first = cleaned.split(" ")[0]
    if first in generics:
        return first
    if first in brands:
        return brands[first]

    # Fuzzy fallback for OCR/spelling near-misses (e.g. "amoxillin" -> amoxicillin).
    # Only after every exact path fails, so correct names are never re-mapped.
    fuzzy = _fuzzy_match(cleaned, generics, brands) or _fuzzy_match(first, generics, brands)
    if fuzzy:
        return fuzzy

    return cleaned


def normalize_drug_name(name: str) -> str:
    """Turn a written drug name (brand or generic, with/without dose) into its
    formal generic name, using the built-in defaults. Returns the cleaned original
    if no match is found (so unknown drugs pass through unchanged)."""
    return normalize_with(name, GENERIC_DRUGS, BRAND_TO_GENERIC)


def drug_classes(generic: str) -> set:
    """Pharmacological classes for a generic drug name (empty set if unknown)."""
    return set(GENERIC_DRUGS.get((generic or "").lower(), []))


# Sorted generic names — handy for any list/autocomplete consumer.
SORTED_GENERICS = sorted(GENERIC_DRUGS.keys())
