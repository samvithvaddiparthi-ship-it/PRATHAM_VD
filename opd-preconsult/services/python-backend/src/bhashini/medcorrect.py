"""
Stage 2 — medical-domain correction, validation and confidence scoring.

Pipeline:
  2a. Lexicon pass (deterministic): apply known confusion swaps + normalise
      English medical-term casing. Cheap, explainable, no model needed.
  2b. LLM validation: a constrained medical post-editor reviews the text and
      returns ONLY word-level fixes for medically-implausible mis-recognitions,
      flagging anything it's unsure about (never guessing confidently).
  2c. Merge + guardrail: the LLM's corrected text is accepted only if it is a
      word-level edit of the input (no paraphrasing/reordering) — otherwise we
      keep the lexicon text and surface the model's notes as "uncertain".
  Confidence is derived (Bhashini gives none) from the edits + LLM signal.

Every result is appended to logs/transcripts.jsonl for error analysis, and
/stats aggregates the most common from->to fixes so the lexicon can grow.
"""
import re
import json
import time
import difflib
from pathlib import Path
from datetime import datetime, timezone

from . import _llm as llm
from .lexicon import (EN_TERMS, DRUGS, LAB_TESTS, DOSAGE_CODES, UNITS,
                             terms_for, confusion_map_for)

LOG_PATH = Path(__file__).parent / "logs" / "transcripts.jsonl"
LOG_PATH.parent.mkdir(exist_ok=True)

# Per-language lexicon structures, built once and cached. DRUGS / LAB_TESTS /
# EN_TERMS are shared (English-based); the symptom+anatomy TERMS and confusion
# phrases are language-specific (Hindi vs Telugu).
_LEX_CACHE = {}


def _title_drug(name: str) -> str:
    """Proper-case a medicine name (first letter of each word), preserving things
    like 'B12'. 'dolo' -> 'Dolo', 'vitamin b12' -> 'Vitamin B12'."""
    return " ".join(w[:1].upper() + w[1:] if w else w for w in name.split())


def _lexicon(lang):
    if lang in _LEX_CACHE:
        return _LEX_CACHE[lang]
    terms = terms_for(lang)
    fuzzy = {}
    for canon, meta in terms.items():
        for c in meta.get("confusions", []):
            fuzzy[c] = canon
    # Drug/lab names: every canonical name AND every alias/brand is a VALID
    # spelling. A word that matches one of these is a real medicine the patient
    # said — keep it as-is (just fix casing); do NOT normalise a brand to its
    # generic (e.g. "Dolo" must stay "Dolo", not become "Paracetamol"). Only a
    # fuzzy NEAR-miss (a genuine mis-hearing) gets corrected to the nearest valid
    # spelling. So drug names go into `drug_names`, not the term→canon `fuzzy` map.
    drug_names = {}   # lowercased valid spelling -> properly-cased valid spelling
    for canon, confs in list(DRUGS.items()) + list(LAB_TESTS.items()):
        for c in [canon] + list(confs):
            drug_names[c.lower()] = _title_drug(c)
    lex = {
        "confusion_map": confusion_map_for(lang),
        "single": {k: v for k, v in fuzzy.items() if " " not in k},
        "multi": {k: v for k, v in fuzzy.items() if " " in k},
        "drug_names": drug_names,
        "canon": set(terms) | set(DRUGS) | set(LAB_TESTS),
        # LLM allow-list: this language's terms + shared drugs/labs + English terms.
        "vocab": sorted(set(list(terms) + list(DRUGS) + list(LAB_TESTS)
                            + [v for v in EN_TERMS.values()])),
    }
    _LEX_CACHE[lang] = lex
    return lex


# Fuzzy-match similarity cutoff. 0.88 keeps over-correction in check now that the
# lexicon is large (more canonical "magnets" => stricter threshold needed).
FUZZY_CUTOFF = 0.88

# Patient-name matching: if a spoken token is at least this similar to the name
# from the registration form, snap it to the registered spelling (just a
# mis-heard name). Below this, leave it as spoken — the patient may be using a
# different name (e.g. last name) that isn't in the form, so we must NOT force it.
NAME_MATCH_CUTOFF = 0.72        # same-script (Latin<->Latin), reliable
# Cross-script (Devanagari speech vs Latin credential) goes through a lossy
# romanisation AND the ASR may mis-hear the name, so the bar is lower.
CROSS_NAME_CUTOFF = 0.62

# Transliteration for cross-script name matching (Devanagari/Telugu <-> Latin).
try:
    from indic_transliteration.sanscript import (transliterate as _xlit,
                                                 DEVANAGARI, TELUGU, HK, ITRANS)
    _HAVE_XLIT = True
except Exception:
    _HAVE_XLIT = False

_DEVA_RE = re.compile(r"[ऀ-ॿ]")
_TELU_RE = re.compile(r"[ఀ-౿]")
_NATIVE_SCHEME = {"hi": DEVANAGARI, "te": TELUGU} if _HAVE_XLIT else {}


def _script_of(s: str):
    if _DEVA_RE.search(s):
        return DEVANAGARI if _HAVE_XLIT else "deva"
    if _TELU_RE.search(s):
        return TELUGU if _HAVE_XLIT else "telu"
    return None


def _romanize(s: str) -> str:
    """Any Indic script (Devanagari/Telugu) -> lowercase ascii skeleton for fuzzy
    matching. Non-Indic text is just lowercased/stripped."""
    sch = _script_of(s)
    if _HAVE_XLIT and sch:
        try:
            s = _xlit(s, sch, HK)
        except Exception:
            pass
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _to_native(latin: str, lang: str) -> str:
    """Latin credential -> the transcript language's script for insertion
    (Hindi -> Devanagari, Telugu -> Telugu)."""
    scheme = _NATIVE_SCHEME.get(lang)
    if not _HAVE_XLIT or scheme is None:
        return latin
    try:
        return _xlit(latin.lower(), ITRANS, scheme).rstrip("్्")  # drop trailing virama
    except Exception:
        return latin

# Numbers / doses / measurements / lab values — detected so they can be (a)
# marked PROTECTED for the LLM and (b) verified unchanged afterwards.
_UNIT_ALT = "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True))
NUM_RE = re.compile(r"\d[\d.,/:\-]*\s?(?:%s)?" % _UNIT_ALT, re.IGNORECASE)
DIGITS_RE = re.compile(r"\d[\d.,/:\-]*")


# ── 2a. deterministic lexicon pass ───────────────────────────────────────────

def apply_lexicon(text: str, lang: str):
    lex = _lexicon(lang)
    single, canon_set = lex["single"], lex["canon"]
    changes = []
    for wrong, right in lex["confusion_map"].items():
        if wrong in text and wrong != right:
            text = text.replace(wrong, right)
            changes.append({"from": wrong, "to": right,
                            "reason": "known ASR confusion (lexicon)", "confidence": 0.95})

    # Multi-word confusions from TERMS/DRUGS (exact substring).
    for wrong, right in lex["multi"].items():
        if wrong in text and wrong != right:
            text = text.replace(wrong, right)
            changes.append({"from": wrong, "to": right,
                            "reason": "medical term (lexicon)", "confidence": 0.9})

    # English medical term casing/spelling — longest keys first so "ct scan"
    # wins over "ct". Word-boundary, case-insensitive; never translates.
    for key in sorted(EN_TERMS, key=len, reverse=True):
        canon = EN_TERMS[key]
        pattern = re.compile(r"(?<![A-Za-z])" + re.escape(key) + r"(?![A-Za-z])", re.IGNORECASE)
        def _sub(m):
            if m.group(0) != canon:
                changes.append({"from": m.group(0), "to": canon,
                                "reason": "normalise English medical term", "confidence": 0.9})
            return canon
        text = pattern.sub(_sub, text)

    # Fuzzy single-word pass: map near-miss tokens to a canonical medical/drug
    # term (native-script or English). Exact confusion hits are high-confidence;
    # fuzzy matches a bit lower. Canonical words and numbers are left alone.
    drug_names = lex["drug_names"]
    toks = text.split(" ")
    for i, tok in enumerate(toks):
        bare = tok.strip(".,!?;:।")  # also strip Devanagari/Telugu danda
        if not bare or bare in canon_set or DIGITS_RE.search(bare):
            continue
        key = bare.lower() if re.search(r"[A-Za-z]", bare) else bare

        # A correctly-spoken medicine (canonical OR brand/alias) is left as said —
        # only its casing is normalised. Never normalise a brand to its generic.
        if key in drug_names:
            proper = drug_names[key]
            if proper != bare:
                toks[i] = tok.replace(bare, proper)
                changes.append({"from": bare, "to": proper,
                                "reason": "medicine name (kept, cased)", "confidence": 0.97})
            continue

        canon = None
        conf = 0.0
        if key in single:                                   # known symptom-term confusion
            canon, conf = single[key], 0.9
        else:
            m = difflib.get_close_matches(key, single.keys(), n=1, cutoff=FUZZY_CUTOFF)
            if m:
                canon, conf = single[m[0]], 0.8
            else:                                           # genuine mis-hearing of a drug
                dm = difflib.get_close_matches(key, drug_names.keys(), n=1, cutoff=FUZZY_CUTOFF)
                if dm:
                    canon, conf = drug_names[dm[0]], 0.8    # -> nearest VALID spelling, not the generic
        if canon and canon != bare:
            toks[i] = tok.replace(bare, canon)
            changes.append({"from": bare, "to": canon,
                            "reason": "fuzzy lexicon match", "confidence": conf})
    text = " ".join(toks)
    return text, changes


# ── measurement protection + verification ────────────────────────────────────

def protected_values(text: str):
    """Numbers, doses, measurements, lab values and Rx frequency codes that must
    NOT be altered by correction."""
    vals = {m.group(0).strip() for m in NUM_RE.finditer(text) if m.group(0).strip()}
    vals |= {w for w in re.findall(r"[A-Za-z]+", text) if w.upper() in DOSAGE_CODES}
    return sorted(vals)


# SAFE-to-de-stutter words: grammatical function words (pronouns, auxiliaries,
# postpositions, conjunctions) that carry NO meaning when doubled. We collapse a
# repeat ONLY if it's one of these — we never touch content words, so meaningful
# reduplications ("बार बार", "कभी कभी", "धीरे धीरे", emphatic doublings) can never
# be altered. Allow-list, not block-list: anything unknown is left untouched.
# English function words shared across languages.
_COLLAPSE_EN = {"i", "me", "my", "the", "a", "an", "is", "are", "was", "and",
                "to", "of", "that", "it"}

COLLAPSE_OK_BY_LANG = {
    "hi": {
        # pronouns
        "मैं", "मुझे", "मेरा", "मेरी", "मेरे", "हम", "हमें", "आप", "तुम", "यह", "वह",
        "ये", "वे", "वो", "इस", "उस",
        # auxiliaries / be-verbs
        "है", "हैं", "हूँ", "हूं", "था", "थे", "थी", "हो",
        # postpositions
        "का", "की", "के", "को", "में", "से", "ने", "पर", "तक",
        # conjunctions / particles
        "और", "कि", "तो", "या",
    } | _COLLAPSE_EN,
    "te": {
        # pronouns
        "నేను", "నాకు", "నా", "మీరు", "మీకు", "అతను", "ఆమె", "ఇది", "అది", "మేము",
        # auxiliaries / be-verbs
        "ఉంది", "ఉన్నాను", "ఉన్నాయి", "ఉన్నారు", "అయింది",
        # postpositions / case markers
        "లో", "కి", "కు", "తో", "నుండి", "మీద", "వరకు", "గురించి",
        # conjunctions / particles
        "మరియు", "కానీ", "అని", "కూడా",
    } | _COLLAPSE_EN,
}


def collapse_repeats(text: str, lang: str):
    """Remove ONLY immediate-stutter duplicates of grammatical FUNCTION words for
    this language — e.g. "मुझे मुझे", "నేను నేను", "the the". Content words and any
    meaningful reduplication ("बार बार" = recurrent, "మెల్లగా మెల్లగా" = slowly) are
    never touched, so meaning is provably preserved. Numbers never collapsed."""
    ok = COLLAPSE_OK_BY_LANG.get(lang, _COLLAPSE_EN)
    toks = text.split(" ")
    out, changes, removed = [], [], 0
    for t in toks:
        bare = t.strip(".,!?;:।").lower()
        prev = out[-1].strip(".,!?;:।").lower() if out else ""
        if bare and bare == prev and bare in ok:
            removed += 1
            continue
        out.append(t)
    if removed:
        changes.append({"from": f"{removed} stutter word(s)", "to": "removed",
                        "reason": "duplicate function-word stutter", "confidence": 0.92})
    return " ".join(out), changes


# Phrases that INTRODUCE the patient's own name. The credential is only snapped
# onto a token that FOLLOWS one of these cues — so an ordinary word that merely
# sounds like the name (and isn't being used as a name) is never rewritten. Each
# cue is a token sequence; Latin cues match case-insensitively, native cues exact.
NAME_CUES = [
    # English
    ["my", "name", "is"], ["name", "is"], ["my", "name's"], ["name's"],
    ["i", "am"], ["i'm"], ["this", "is"], ["myself"], ["call", "me"],
    # Hindi (romanised + Devanagari)
    ["mera", "naam"], ["naam"], ["मेरा", "नाम"], ["नाम"],
    # Telugu (romanised + Telugu)
    ["na", "peru"], ["naa", "peru"], ["peru"], ["నా", "పేరు"], ["పేరు"],
]


def _name_candidate_starts(toks):
    """Token indices that come RIGHT AFTER a name-introduction cue — the only
    positions where a name replacement is allowed."""
    low = [t.lower().strip(".,!?;:।") for t in toks]
    starts = set()
    for cue in NAME_CUES:
        n = len(cue)
        for i in range(len(low) - n + 1):
            if low[i:i + n] == cue and i + n < len(toks):
                starts.add(i + n)
    return sorted(starts)


def apply_name(text: str, patient_name: str, lang: str):
    """Snap a mis-heard spoken name to the registered credential — but ONLY when
    (a) the word is clearly the same name (fuzzy match clears the cutoff), AND
    (b) it actually appears in a NAME context, i.e. right after a cue like
    "my name is" / "mera naam" / "నా పేరు". Without a name cue, nothing is
    touched — so a random word that merely sounds like the name is left alone.

    Works ACROSS SCRIPTS: a Devanagari/Telugu spoken name is romanised and
    compared to a Latin credential; on match it is rendered in the TRANSCRIPT's
    script (Option B). A name very different from the credential (e.g. a surname)
    clears nothing and is left exactly as spoken."""
    changes = []
    name = (patient_name or "").strip()
    name_key = _romanize(name)
    if not name or not name_key:
        return text, changes
    name_is_indic = _script_of(name) is not None

    toks = text.split(" ")
    starts = _name_candidate_starts(toks)
    if not starts:
        return text, changes   # no "my name is…" cue → never rewrite anything
    best = None  # (margin, ratio, i, j, span, cross)
    for i in starts:
        for j in (i + 1, i + 2):
            if j > len(toks):
                continue
            span = " ".join(toks[i:j]).strip(".,!?;:।")
            if not span or DIGITS_RE.search(span):
                continue
            span_key = _romanize(span)
            if not span_key:
                continue
            cross = (_script_of(span) is not None) != name_is_indic
            cutoff = CROSS_NAME_CUTOFF if cross else NAME_MATCH_CUTOFF
            ratio = difflib.SequenceMatcher(None, span_key, name_key).ratio()
            margin = ratio - cutoff           # compare candidates fairly across cutoffs
            if ratio >= cutoff and (best is None or margin > best[0]):
                best = (margin, ratio, i, j, span, cross)

    if best:
        _, ratio, i, j, span, cross = best
        # Option B: render the credential in the transcript's script.
        repl = name
        if cross and _script_of(span) is not None and not name_is_indic:
            repl = _to_native(name, lang)
        if repl and repl != span:
            toks[i:j] = [repl]
            tag = "cross-script " if cross else ""
            changes.append({"from": span, "to": repl,
                            "reason": f"matched registered name ({tag}{ratio:.0%} similar)",
                            "confidence": round(ratio, 2)})
    return " ".join(toks), changes


def verify_numbers(raw: str, corrected: str, uncertain: list):
    """If the multiset of numeric tokens changed during correction, flag it for
    human verification (numbers are never silently 'corrected')."""
    if sorted(DIGITS_RE.findall(raw)) != sorted(DIGITS_RE.findall(corrected)):
        uncertain.append({
            "span": "numeric / measurement value",
            "alternatives": [],
            "reason": "a number, dose or measurement changed during correction — verify with the patient",
        })
    return uncertain


# ── 2b. LLM validation ───────────────────────────────────────────────────────

LANG_NAME = {"hi": "Hindi", "te": "Telugu", "en": "English"}

SYSTEM_PROMPT = """You are a medical ASR post-editor for an Indian OPD (outpatient clinic). \
The input is a RAW speech-to-text transcript of a patient speaking in __LANG__, often mixed with English medical terms. \
Your ONLY job is to fix words that the recogniser clearly got wrong into something medically implausible.

HARD RULES:
- Preserve the patient's exact wording, word order, grammar and colloquial style.
- Do NOT translate, paraphrase, summarise, expand, reorder, or add/remove information.
- Only substitute a word when a medically more-plausible NEAR-HOMOPHONE exists in context \
(in Hindi e.g. "खून की चर्चा" -> "खून की जाँच"; in Telugu e.g. "రక్త పోటు" -> "రక్తపోటు").
- Keep code-switched English medical terms; only normalise casing (ecg->ECG, bp->BP). Never translate them to __LANG__ or vice-versa.
- When fixing a medical, anatomical or drug word, PREFER a term from `medical_vocabulary` (provided). Do not invent medical terms outside it unless the correct word is obvious.
- NEVER change any token listed in `protected_values` (numbers, doses, measurements, lab values, Rx frequency codes like BD/OD/TDS) — copy them EXACTLY. If a value sounds wrong, do not fix it; add it to "uncertain" instead.
- If you are NOT confident a word is wrong, KEEP the original and list it under "uncertain" with alternatives. Never guess confidently.
- If nothing needs changing, return the text unchanged with an empty changes list.

Return STRICT JSON ONLY, no prose, with this schema:
{"corrected": "<full corrected transcript>",
 "confidence": <0..1 overall>,
 "changes": [{"from": "<orig word/phrase>", "to": "<fixed>", "reason": "<why>", "confidence": <0..1>}],
 "uncertain": [{"span": "<word/phrase>", "alternatives": ["<alt1>", "<alt2>"], "reason": "<why unsure>"}]}"""


def _system_prompt(lang: str) -> str:
    return SYSTEM_PROMPT.replace("__LANG__", LANG_NAME.get(lang, lang))


def _build_user(text: str, lang: str, hints, protected):
    hint_str = json.dumps(hints, ensure_ascii=False) if hints else "[]"
    vocab = _lexicon(lang)["vocab"]
    return (f"language: {LANG_NAME.get(lang, lang)}\n"
            f"raw_transcript: {json.dumps(text, ensure_ascii=False)}\n"
            f"lexicon_candidates_already_applied: {hint_str}\n"
            f"protected_values: {json.dumps(protected, ensure_ascii=False)}\n"
            f"medical_vocabulary: {json.dumps(vocab, ensure_ascii=False)}\n"
            f"Return the JSON now.")


def _parse_json(s: str):
    s = s.strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s).rstrip("`").strip()
    try:
        return json.loads(s)
    except Exception:
        m = re.search(r"\{.*\}", s, re.S)
        if m:
            return json.loads(m.group(0))
        raise


def llm_validate(text: str, lang: str, hints, protected):
    if not llm.have_llm():
        return None
    raw = llm.complete_json(_system_prompt(lang), _build_user(text, lang, hints, protected), max_tokens=1024)
    return _parse_json(raw)


# ── 2c. merge with anti-paraphrase guardrail ─────────────────────────────────

def _tokens(s: str):
    return re.findall(r"\S+", s)


def _is_word_level_edit(before: str, after: str) -> bool:
    """Accept the LLM edit only if it's word substitutions — not a rewrite.
    Reject if it changes token count by >2 or reorders heavily."""
    b, a = _tokens(before), _tokens(after)
    if abs(len(a) - len(b)) > 2:
        return False
    sm = difflib.SequenceMatcher(a=b, b=a)
    # 'replace' ops are word swaps (allowed); large delete/insert blocks are not.
    changed = sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in sm.get_opcodes()
                  if tag != "equal")
    return changed <= max(3, len(b) // 4)  # at most ~25% of tokens touched


def _diff_changes(before: str, after: str):
    """Word-level from->to list between two strings."""
    b, a = _tokens(before), _tokens(after)
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=b, b=a).get_opcodes():
        if tag == "replace":
            out.append({"from": " ".join(b[i1:i2]), "to": " ".join(a[j1:j2]),
                        "reason": "medical-domain correction", "confidence": 0.8})
    return out


def _score(changes, uncertain, llm_conf, llm_used):
    """REVIEW confidence for the CORRECTION stage — NOT a transcription-accuracy
    guarantee. Bhashini provides no acoustic word-confidence, so we cannot
    measure how right the raw ASR is; this only reflects how safe the correction
    pass was. Therefore it is capped below 100% and is lowered when:
      (a) the medical LLM could not validate the transcript (unavailable),
      (b) any single edit was a low-confidence guess (the weakest edit drags the
          whole result down — one shaky correction means a human should look),
      (c) spans were explicitly flagged uncertain."""
    if llm_used and isinstance(llm_conf, (int, float)):
        base = 0.72 + 0.23 * float(llm_conf)   # LLM medically validated it
    elif llm_used:
        base = 0.88
    else:
        base = 0.80                            # LLM unavailable -> NOT validated
    if changes:
        weakest = min(ch.get("confidence", 0.8) for ch in changes)
        base -= (1.0 - weakest) * 0.30
    base -= 0.12 * len(uncertain)
    return round(max(0.30, min(0.95, base)), 2)  # never claim 100%


def _normalise_spacing(s: str) -> str:
    """Some ASR output glues a word to the next after sentence punctuation with no
    space ('Sambit.I've', '650.My'). Insert a space after . , ! ? ; : when it's
    immediately followed by a LETTER (Latin or Indic) — never after a digit, so
    decimals like '5.5' are untouched. This lets word-level steps (name match,
    de-stutter) see proper tokens."""
    return re.sub(r"([.,!?;:])(?=[A-Za-zऀ-ॿఀ-౿])", r"\1 ", s)


def correct(raw: str, lang: str, patient_name: str = "") -> dict:
    t0 = time.perf_counter()
    raw = _normalise_spacing(raw)
    text, lex_changes = apply_lexicon(raw, lang)
    text, repeat_changes = collapse_repeats(text, lang)
    text, name_changes = apply_name(text, patient_name, lang)
    lex_changes += repeat_changes + name_changes
    protected = protected_values(raw)
    if patient_name.strip():
        # the registered name is now canonical — keep the LLM from altering it
        protected = sorted(set(protected) | {patient_name.strip()})

    llm_out, llm_conf, uncertain = None, None, []
    used_llm = False
    try:
        llm_out = llm_validate(text, lang, lex_changes, protected)
    except Exception as e:
        print(f"[medcorrect] LLM step failed ({type(e).__name__}: {e}); "
              f"using lexicon-only result", flush=True)

    corrected = text
    llm_changes = []
    if llm_out and isinstance(llm_out, dict):
        cand = (llm_out.get("corrected") or "").strip()
        uncertain = llm_out.get("uncertain") or []
        llm_conf = llm_out.get("confidence")
        if cand and cand != text and _is_word_level_edit(text, cand):
            corrected = cand
            llm_changes = _diff_changes(text, cand)
            used_llm = True
        elif cand and cand != text:
            # Looked like a rewrite — reject it, flag the difference instead.
            uncertain = uncertain + [{
                "span": text, "alternatives": [cand],
                "reason": "model suggested a larger rewrite; kept original to avoid paraphrasing"
            }]

    # Numbers/doses/measurements are never silently changed — flag if they did.
    uncertain = verify_numbers(raw, corrected, uncertain)

    changes = lex_changes + llm_changes
    confidence = _score(changes, uncertain, llm_conf, used_llm)
    ms = int((time.perf_counter() - t0) * 1000)

    result = {
        "raw": raw,
        "corrected": corrected,
        "confidence": confidence,
        "changes": changes,
        "uncertain": uncertain,
        "stage2_ms": ms,
        "llm_used": used_llm,
        "llm_provider": llm.last_provider() if used_llm else None,
        "llm_model": llm.last_model() if used_llm else None,
    }
    _log(lang, result)
    return result


# ── logging + error analysis ─────────────────────────────────────────────────

def _log(lang: str, result: dict):
    try:
        rec = {"ts": datetime.now(timezone.utc).isoformat(), "lang": lang,
               "raw": result["raw"], "corrected": result["corrected"],
               "confidence": result["confidence"], "changes": result["changes"],
               "uncertain": result["uncertain"], "llm_used": result["llm_used"]}
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[medcorrect] log write failed: {e}", flush=True)


def stats(top: int = 20):
    """Aggregate recurring from->to corrections from the log for error analysis."""
    counts, n, low_conf = {}, 0, 0
    if LOG_PATH.exists():
        for line in LOG_PATH.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except Exception:
                continue
            n += 1
            if rec.get("confidence", 1) < 0.6:
                low_conf += 1
            for ch in rec.get("changes", []):
                key = f"{ch['from']} → {ch['to']}"
                counts[key] = counts.get(key, 0) + 1
    top_changes = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:top]
    return {"total_transcripts": n, "low_confidence": low_conf,
            "top_corrections": [{"fix": k, "count": v} for k, v in top_changes]}
