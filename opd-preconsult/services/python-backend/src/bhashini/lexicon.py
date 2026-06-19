"""
Curated Hindi-English medical lexicon for Stage-2 ASR correction.

Three structures:
  TERMS          canonical Hindi term -> English equivalents + known ASR confusions
                 (used to build hints for the LLM and to validate its edits).
  CONFUSION_MAP  high-confidence, context-independent wrong->right phrase swaps
                 applied deterministically before the LLM (cheap, explainable).
  EN_TERMS       English medical tokens normalised for casing/spelling only
                 (never translated) — supports mixed Hindi-English speech.

This is intentionally small and curated; the /stats endpoint surfaces recurring
from->to corrections so this list can grow from real failures over time.
"""

TERMS_HI = {
    "जाँच":                  {"en": ["test", "investigation"], "confusions": ["चर्चा", "जांच", "चर्जा"]},
    "खून की जाँच":           {"en": ["blood test"], "confusions": ["खून की चर्चा", "खून की जांच"]},
    "बुखार":                 {"en": ["fever"], "confusions": ["बुखारी", "बुखा", "बुकार"]},
    "सीने में दर्द":          {"en": ["chest pain"], "confusions": ["सिने में दर्द", "सीने मैं दर्द"]},
    "साँस लेने में तकलीफ":    {"en": ["shortness of breath", "breathlessness"], "confusions": ["सांस की तकलीफ", "सास लेने में तकलीफ"]},
    "चक्कर":                 {"en": ["dizziness", "giddiness"], "confusions": ["चक्र", "चककर", "चक्कड़"]},
    "कमज़ोरी":               {"en": ["weakness"], "confusions": ["कमजोरी", "कमज़ोर"]},
    "जी मिचलाना":            {"en": ["nausea"], "confusions": ["जी मचलाना", "जी मिचलना"]},
    "उल्टी":                 {"en": ["vomiting"], "confusions": ["ुल्टी", "उलटी"]},
    "उच्च रक्तचाप":          {"en": ["hypertension", "high blood pressure", "high BP"], "confusions": ["रक्तचाप", "उच्च रक्त चाप"]},
    "मधुमेह":                {"en": ["diabetes", "sugar"], "confusions": ["मधुमय", "मधुमेय"]},
    "दवा":                   {"en": ["medication", "medicine"], "confusions": ["दावा", "दवाई"]},
    "पर्ची":                 {"en": ["prescription"], "confusions": ["परची", "पर्चा"]},
    "धड़कन":                 {"en": ["palpitations", "heartbeat"], "confusions": ["धड़कने", "धरकन"]},
    "सूजन":                  {"en": ["swelling"], "confusions": ["सुजन", "सूझन"]},
    "बेहोशी":                {"en": ["fainting", "syncope"], "confusions": ["बेहोश"]},
    "सिरदर्द":               {"en": ["headache"], "confusions": ["सर दर्द", "सिर्दर्द"]},
    # Anatomy / urology & procedures (from real test recordings: kidney stones,
    # ureter obstruction, stent, laser).
    "किडनी":                 {"en": ["kidney"], "confusions": ["किडनि", "केडनी", "किड्नी"]},
    "गुर्दा":                {"en": ["kidney"], "confusions": ["गुरदा", "गुर्धा"]},
    "पथरी":                  {"en": ["stone", "calculus"], "confusions": ["पत्थरी", "पथरि", "पथ्री"]},
    "मूत्रवाहिनी":           {"en": ["ureter"], "confusions": ["मूत्र वाहिनी", "मुत्रवाहिनी"]},
    "मूत्राशय":              {"en": ["bladder"], "confusions": ["मूत्र आशय", "मुत्राशय"]},
    "पेशाब":                 {"en": ["urine", "urination"], "confusions": ["पेसाब", "पेशब"]},
    "स्टेंट":                {"en": ["stent"], "confusions": ["स्टंट", "इस्टेंट", "स्टैंट"]},
    "लेज़र":                 {"en": ["laser"], "confusions": ["लेजर", "लेसर"]},
    "ऑपरेशन":               {"en": ["operation", "surgery"], "confusions": ["आपरेशन", "ओपरेशन"]},
    "रिपोर्ट":               {"en": ["report"], "confusions": ["रिपोट", "रपोर्ट"]},
}

# Common OPD drug names: canonical display form -> spoken / ASR confusions
# (English + Devanagari + frequent brand names). Used to (a) normalise drug
# mentions deterministically, and (b) seed the LLM allow-list. Drug names need
# high fidelity — a near-homophone swap here changes the prescription.
DRUGS = {
    # Analgesics / antipyretics / NSAIDs
    "Paracetamol":  ["paracetamol", "पैरासिटामोल", "पेरासिटामोल", "crocin", "dolo", "calpol"],
    "Ibuprofen":    ["ibuprofen", "brufen", "combiflam"],
    "Diclofenac":   ["diclofenac", "voveran", "volini"],
    "Aceclofenac":  ["aceclofenac", "zerodol", "hifenac"],
    "Aspirin":      ["aspirin", "एस्पिरिन", "ecosprin", "disprin"],
    "Tramadol":     ["tramadol"],
    # Antibiotics
    "Amoxicillin":  ["amoxicillin", "एमोक्सिसिलिन", "amoxy", "mox"],
    "Amoxicillin-Clavulanate": ["augmentin", "clavam", "amoxiclav", "co-amoxiclav"],
    "Azithromycin": ["azithromycin", "एजिथ्रोमाइसिन", "azithral", "azee"],
    "Ciprofloxacin":["ciprofloxacin", "ciplox", "cifran"],
    "Ofloxacin":    ["ofloxacin", "oflox"],
    "Levofloxacin": ["levofloxacin", "levoflox"],
    "Cefixime":     ["cefixime", "cefix", "taxim-o"],
    "Cephalexin":   ["cephalexin", "sporidex"],
    "Doxycycline":  ["doxycycline", "doxy"],
    "Metronidazole":["metronidazole", "flagyl", "metrogyl"],
    "Norfloxacin":  ["norfloxacin", "norflox"],
    "Cotrimoxazole":["cotrimoxazole", "septran", "bactrim"],
    "Nitrofurantoin":["nitrofurantoin", "niftran"],
    # Antidiabetics
    "Metformin":    ["metformin", "मेटफॉर्मिन", "मेटफार्मिन", "glycomet"],
    "Glimepiride":  ["glimepiride", "amaryl"],
    "Glibenclamide":["glibenclamide", "daonil"],
    "Gliclazide":   ["gliclazide"],
    "Sitagliptin":  ["sitagliptin", "januvia"],
    "Vildagliptin": ["vildagliptin", "galvus"],
    "Insulin":      ["insulin", "इंसुलिन", "इन्सुलिन"],
    # Antihypertensives / cardiac
    "Amlodipine":   ["amlodipine", "एम्लोडिपिन", "amlo", "amlong"],
    "Telmisartan":  ["telmisartan", "टेल्मिसार्टन", "telma"],
    "Losartan":     ["losartan", "लोसार्टन", "losar"],
    "Olmesartan":   ["olmesartan"],
    "Ramipril":     ["ramipril"],
    "Enalapril":    ["enalapril"],
    "Atenolol":     ["atenolol"],
    "Metoprolol":   ["metoprolol", "मेटोप्रोलोल", "metolar"],
    "Bisoprolol":   ["bisoprolol"],
    "Hydrochlorothiazide": ["hydrochlorothiazide", "hctz"],
    "Furosemide":   ["furosemide", "lasix"],
    "Clopidogrel":  ["clopidogrel", "clopilet", "plavix"],
    "Isosorbide":   ["isosorbide", "sorbitrate"],
    # Statins
    "Atorvastatin": ["atorvastatin", "एटोरवास्टेटिन", "atorva"],
    "Rosuvastatin": ["rosuvastatin", "rosuvas"],
    "Simvastatin":  ["simvastatin"],
    # GI / PPIs / antiemetics
    "Pantoprazole": ["pantoprazole", "पैंटोप्राजोल", "pantop", "pan"],
    "Omeprazole":   ["omeprazole", "ओमेप्राजोल", "omez"],
    "Rabeprazole":  ["rabeprazole", "rabium"],
    "Esomeprazole": ["esomeprazole", "nexium"],
    "Ranitidine":   ["ranitidine", "rantac"],
    "Domperidone":  ["domperidone", "domstal"],
    "Ondansetron":  ["ondansetron", "emeset"],
    "Dicyclomine":  ["dicyclomine", "cyclopam"],
    "Drotaverine":  ["drotaverine", "drotin"],
    # Respiratory / allergy
    "Cetirizine":   ["cetirizine", "सेटिरिजिन", "cetrizine", "cetzine"],
    "Levocetirizine":["levocetirizine", "levocet"],
    "Montelukast":  ["montelukast", "montair"],
    "Salbutamol":   ["salbutamol", "asthalin", "ventolin"],
    "Budesonide":   ["budesonide"],
    "Fexofenadine": ["fexofenadine", "allegra"],
    "Chlorpheniramine": ["chlorpheniramine", "cpm"],
    # Thyroid / steroids
    "Thyroxine":    ["thyroxine", "levothyroxine", "eltroxin", "thyronorm"],
    "Prednisolone": ["prednisolone", "wysolone"],
    "Dexamethasone":["dexamethasone", "dexona"],
    "Hydrocortisone":["hydrocortisone"],
    # Supplements
    "Calcium":      ["calcium", "shelcal", "calcium carbonate"],
    "Vitamin D3":   ["vitamin d", "vitamin d3", "cholecalciferol", "calcirol"],
    "Vitamin B12":  ["vitamin b12", "methylcobalamin", "mecobalamin"],
    "Folic acid":   ["folic acid", "folvite"],
    "Iron":         ["iron", "ferrous sulphate", "ferrous ascorbate", "orofer"],
    "Pregabalin":   ["pregabalin", "pregabalin", "pregeb"],
    "Gabapentin":   ["gabapentin"],
}

# Common lab tests / investigations. Canonical -> spoken aliases / abbreviations.
# Used for normalisation + the LLM allow-list. (Lab VALUES are numbers, already
# protected; this covers the TEST NAMES so they aren't mangled.)
LAB_TESTS = {
    "CBC":               ["cbc", "complete blood count", "hemogram", "haemogram"],
    "Hemoglobin":        ["hemoglobin", "haemoglobin", "hb", "hb level"],
    "Platelet count":    ["platelet count", "platelets", "platelet"],
    "TLC":               ["tlc", "total leukocyte count", "wbc count"],
    "Fasting blood sugar":["fasting blood sugar", "fbs", "fasting sugar"],
    "Postprandial blood sugar":["postprandial", "ppbs", "pp sugar"],
    "Random blood sugar":["random blood sugar", "rbs"],
    "HbA1c":             ["hba1c", "hb a1c", "glycosylated hemoglobin", "glycated hemoglobin"],
    "Creatinine":        ["creatinine", "serum creatinine"],
    "Blood urea":        ["blood urea", "urea", "bun"],
    "Uric acid":         ["uric acid", "serum uric acid"],
    "Sodium":            ["sodium", "serum sodium", "na+"],
    "Potassium":         ["potassium", "serum potassium", "k+"],
    "KFT":               ["kft", "kidney function test", "rft", "renal function test"],
    "LFT":               ["lft", "liver function test"],
    "SGOT":              ["sgot", "ast"],
    "SGPT":              ["sgpt", "alt"],
    "Bilirubin":         ["bilirubin", "serum bilirubin"],
    "Lipid profile":     ["lipid profile", "cholesterol", "ldl", "hdl", "triglycerides"],
    "TSH":               ["tsh", "thyroid profile"],
    "T3":                ["t3"],
    "T4":                ["t4"],
    "ESR":               ["esr"],
    "CRP":               ["crp", "c-reactive protein"],
    "Vitamin D":         ["vitamin d level", "25-oh vitamin d", "25 hydroxy vitamin d"],
    "Vitamin B12 level": ["vitamin b12 level", "b12 level"],
    "Urine routine":     ["urine routine", "urine examination", "urine r/m"],
    "Serum calcium":     ["serum calcium", "calcium level"],
}

# Dosage frequency shorthand kept verbatim (Indian Rx convention).
DOSAGE_CODES = {"OD", "BD", "TDS", "QID", "HS", "SOS", "STAT", "PRN"}

# Measurement units we protect verbatim (never "corrected"). Lowercased.
UNITS = ["mg", "ml", "mcg", "g", "kg", "mmhg", "mmol/l", "mg/dl", "bpm",
         "%", "iu", "units", "/min", "cm", "mm", "ng/ml", "u/l"]


# Applied verbatim before the LLM step. Keep ONLY swaps you're confident about in
# a medical context (these never need the model's judgement).
CONFUSION_MAP_HI = {
    "खून की चर्चा": "खून की जाँच",
    "खून की जांच": "खून की जाँच",
    "जांच": "जाँच",
    "सिने में दर्द": "सीने में दर्द",
}

# English medical terms: normalise casing/spelling only — NEVER translate.
# Keyed by lowercased form -> canonical display form.
EN_TERMS = {
    "ecg": "ECG", "ekg": "ECG",
    "bp": "BP", "b.p.": "BP",
    "mri": "MRI",
    "ct scan": "CT scan", "ct": "CT", "cat scan": "CT scan",
    "ultrasound": "ultrasound", "usg": "USG",
    "x-ray": "X-ray", "xray": "X-ray",
    "echo": "Echo",
    "spo2": "SpO2", "sp02": "SpO2",
    "sugar": "sugar",
    "diabetes": "diabetes",
    "hypertension": "hypertension",
    "tablet": "tablet", "tab": "tablet",
}


# ── Telugu (తెలుగు) medical lexicon ──────────────────────────────────────────
# Canonical Telugu term -> English equivalents + likely ASR confusions (spelling
# variants). Curated like the Hindi set; the /stats log grows it from real errors.
TERMS_TE = {
    "జ్వరం":            {"en": ["fever"], "confusions": ["జరం", "జ్వరమ్", "జువరం"]},
    "దగ్గు":            {"en": ["cough"], "confusions": ["దగు", "ధగ్గు"]},
    "తలనొప్పి":         {"en": ["headache"], "confusions": ["తల నొప్పి", "తలనోప్పి"]},
    "కడుపు నొప్పి":     {"en": ["stomach pain", "abdominal pain"], "confusions": ["కడుపునొప్పి", "కడప నొప్పి"]},
    "ఛాతీ నొప్పి":      {"en": ["chest pain"], "confusions": ["ఛాతి నొప్పి", "చాతీ నొప్పి"]},
    "ఊపిరి ఆడటం లేదు":  {"en": ["breathlessness", "shortness of breath"], "confusions": ["ఊపిరి ఆడడం లేదు", "ఊపిరి అందటం లేదు"]},
    "తల తిరగడం":        {"en": ["dizziness", "giddiness"], "confusions": ["తలతిరగడం", "తల తిరుగుడు"]},
    "నీరసం":            {"en": ["weakness", "fatigue"], "confusions": ["నీరసమ్", "నిరసం"]},
    "వాంతి":            {"en": ["vomiting"], "confusions": ["వాంతులు", "వాంతీ"]},
    "వికారం":           {"en": ["nausea"], "confusions": ["వికారమ్", "వెకారం"]},
    "రక్తపోటు":         {"en": ["blood pressure", "BP"], "confusions": ["రక్త పోటు", "రక్తపోటూ"]},
    "మధుమేహం":          {"en": ["diabetes", "sugar"], "confusions": ["మధుమేహమ్", "చక్కెర వ్యాధి", "చక్కర వ్యాధి"]},
    "మందు":             {"en": ["medicine", "medication"], "confusions": ["మందులు", "మంది"]},
    "రక్త పరీక్ష":      {"en": ["blood test"], "confusions": ["రక్తపరీక్ష", "రక్త పరిక్ష"]},
    "పరీక్ష":           {"en": ["test", "investigation"], "confusions": ["పరిక్ష", "పరీక్షా"]},
    "మూత్రం":           {"en": ["urine"], "confusions": ["మూత్రమ్", "మూత్ర"]},
    "కిడ్నీ":           {"en": ["kidney"], "confusions": ["కిడ్ని", "మూత్రపిండం", "కిడ్ని"]},
    "రాయి":             {"en": ["stone", "calculus"], "confusions": ["రాళ్ళు", "రాయీ"]},
    "నొప్పి":           {"en": ["pain"], "confusions": ["నోప్పి", "నొప్పీ"]},
    "వాపు":             {"en": ["swelling"], "confusions": ["వాపూ"]},
    "నిద్ర పట్టడం లేదు": {"en": ["unable to sleep", "insomnia"], "confusions": ["నిద్ర రావడం లేదు"]},
    "ఆకలి లేదు":        {"en": ["loss of appetite"], "confusions": ["ఆకలి కావడం లేదు"]},
    "గుండె దడ":         {"en": ["palpitations"], "confusions": ["గుండెదడ"]},
}

# High-confidence exact Telugu phrase normalisations.
CONFUSION_MAP_TE = {
    "రక్త పోటు": "రక్తపోటు",
    "చక్కర వ్యాధి": "మధుమేహం",
}

# Telugu-script aliases for the most common drugs (patients usually say the
# English/brand name, but add the few spoken in Telugu script).
for _canon, _aliases in {
    "Paracetamol": ["పారాసిటమాల్", "పారాసెటమాల్"],
    "Metformin":   ["మెట్‌ఫార్మిన్"],
    "Insulin":     ["ఇన్సులిన్"],
    "Amlodipine":  ["అమ్లోడిపిన్"],
    "Aspirin":     ["ఆస్పిరిన్"],
    "Pantoprazole":["పాంటోప్రజోల్"],
}.items():
    DRUGS.setdefault(_canon, [])
    DRUGS[_canon] += _aliases

# ── Language lookup ──────────────────────────────────────────────────────────
TERMS_BY_LANG = {"hi": TERMS_HI, "te": TERMS_TE}
CONFUSION_MAP_BY_LANG = {"hi": CONFUSION_MAP_HI, "te": CONFUSION_MAP_TE}


def terms_for(lang):
    return TERMS_BY_LANG.get(lang, {})


def confusion_map_for(lang):
    return CONFUSION_MAP_BY_LANG.get(lang, {})
