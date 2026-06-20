import os
import logging
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional

from .. import drug_repo, llm_client
from ..drug_data import normalize_with
from ..drug_interactions import check_interactions, check_allergies, check_duplicates
from ..llm_json import parse_or_none
from ..llm_client import LLMUnavailable

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/prescription", tags=["prescription"])


class InteractionCheckRequest(BaseModel):
    drug_name: str
    other_drugs: List[str] = []
    patient_allergies: List[str] = []


class BulkCheckRequest(BaseModel):
    drugs: List[str]
    patient_allergies: List[str] = []
    session_id: Optional[str] = None
    ai: bool = True   # False = curated drug-drug + allergy only (fast, no LLM) for live auto-checks


@router.post("/check-interactions")
async def check_drug_interactions(req: InteractionCheckRequest):
    """Check a single drug against other drugs and patient allergies (curated only)."""
    rules = drug_repo.load_curated()
    drug_warnings = check_interactions(req.drug_name, req.other_drugs, rules)
    allergy_warnings = check_allergies(req.drug_name, req.patient_allergies, rules)
    has_block = any(w["severity"] == "block" for w in drug_warnings + allergy_warnings)
    return {
        "drug": req.drug_name,
        "drug_interactions": drug_warnings,
        "allergy_warnings": allergy_warnings,
        "has_block": has_block,
    }


# ── AI fallback for drugs not in the curated formulary ────────────────────────

AI_SYSTEM = (
    "You are a clinical pharmacology assistant checking drug-drug interactions for a "
    "doctor's prescription. You are given the drugs being prescribed together; some are "
    "marked (unknown) because they are not in our curated database. Assess clinically "
    "significant interactions ONLY for pairs that involve at least one (unknown) drug — "
    "ignore pairs where both drugs are known. Respond with ONLY a JSON array (no prose). "
    "Each element: {\"drug_a\": string, \"drug_b\": string, "
    "\"severity\": \"none\"|\"warn\"|\"block\", \"mechanism\": string, "
    "\"recommendation\": string, \"confidence\": number 0..1}. "
    "Use 'block' only for dangerous/contraindicated combinations, 'warn' for caution. "
    "Omit any pair whose severity is 'none'. Use the exact drug names as written. "
    "Be TERSE: 'mechanism' and 'recommendation' must each be ONE short sentence "
    "(max ~120 characters), no preamble, no repetition — written for a busy clinician."
)


def _ai_assess(labeled, allergies):
    """One batched LLM call. `labeled` = [{name, known}]. Returns parsed list or raises."""
    lines = "\n".join(f"- {d['name']}" + ("  (unknown)" if not d["known"] else "") for d in labeled)
    allergy_line = ", ".join([a for a in allergies if a]) or "none"
    user = (f"Drugs prescribed together:\n{lines}\n\n"
            f"Patient allergies: {allergy_line}\n\n"
            "Return the JSON array of significant interactions involving the (unknown) drugs.")
    raw = llm_client.complete(AI_SYSTEM, user, max_tokens=1200)
    data = parse_or_none(raw)
    return data if isinstance(data, list) else []


@router.post("/check-bulk")
async def check_bulk_interactions(req: BulkCheckRequest):
    """Curated check for all drugs + an AI advisory for drugs not in the formulary.
    AI results are clearly flagged, never count toward has_block, and are queued for
    HIS-admin review — they are never written to the curated tables here."""
    rules = drug_repo.load_curated()
    generics, brands = rules["generics"], rules["brands"]

    all_warnings = []
    seen_pairs = set()

    # 1) Curated drug-drug + allergy checks (these can BLOCK).
    for i, drug in enumerate(req.drugs):
        others = [d for j, d in enumerate(req.drugs) if j != i]
        for warning in check_interactions(drug, others, rules):
            pair = tuple(sorted([warning["drug_a"].lower(), warning["drug_b"].lower()]))
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                all_warnings.append(warning)
        for warning in check_allergies(drug, req.patient_allergies, rules):
            all_warnings.append(warning)

    all_warnings.extend(check_duplicates(req.drugs, rules))
    has_block = any(w["severity"] == "block" for w in all_warnings)

    # 2) AI advisory for any drug not in the curated formulary.
    labeled, unknowns = [], []
    for d in req.drugs:
        norm = normalize_with(d, generics, brands)
        known = norm in generics
        labeled.append({"name": norm, "known": known})
        if not known:
            unknowns.append(norm)

    ai_checked = False
    ai_error = None
    if req.ai and unknowns and llm_client.has_llm():
        try:
            findings = _ai_assess(labeled, req.patient_allergies)
            ai_checked = True
            model = os.getenv("GEMINI_MODEL", "llm")
            for f in findings:
                sev = str(f.get("severity", "none")).lower()
                if sev not in ("warn", "block"):
                    continue
                a, b = str(f.get("drug_a", "")).strip(), str(f.get("drug_b", "")).strip()
                if not a or not b:
                    continue
                mech = (f.get("mechanism") or "").strip()
                rec = (f.get("recommendation") or "").strip()
                desc = " ".join(x for x in [mech, rec] if x) or "Potential interaction."
                conf = f.get("confidence")
                all_warnings.append({
                    "drug_a": a, "drug_b": b,
                    "severity": sev,            # advisory only — see has_block above
                    "description": desc,
                    "source": "ai", "unverified": True, "confidence": conf,
                })
                # Queue for HIS-admin review (the only AI write). Pick the unknown side.
                a_known = normalize_with(a, generics, brands) in generics
                unknown_side, other_side = (b, a) if a_known else (a, b)
                try:
                    drug_repo.enqueue_finding(unknown_side, other_side, sev, desc, mech, conf, model, req.session_id)
                except Exception:
                    logger.exception("[check-bulk] enqueue_finding failed")
        except LLMUnavailable as e:
            ai_error = str(e)
        except Exception:
            logger.exception("[check-bulk] AI assessment failed")
            ai_error = "AI interaction check is temporarily unavailable."

    return {
        "drugs": req.drugs,
        "warnings": all_warnings,
        "has_block": has_block,         # curated blocks only
        "ai_checked": ai_checked,
        "unknown_drugs": unknowns,
        "ai_error": ai_error,
    }
