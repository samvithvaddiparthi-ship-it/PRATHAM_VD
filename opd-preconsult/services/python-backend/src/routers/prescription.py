from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional
from ..drug_interactions import check_interactions, check_allergies, check_duplicates

router = APIRouter(prefix="/api/prescription", tags=["prescription"])


class InteractionCheckRequest(BaseModel):
    drug_name: str
    other_drugs: List[str] = []
    patient_allergies: List[str] = []


class BulkCheckRequest(BaseModel):
    drugs: List[str]
    patient_allergies: List[str] = []


@router.post("/check-interactions")
async def check_drug_interactions(req: InteractionCheckRequest):
    """Check a single drug against other drugs and patient allergies."""
    drug_warnings = check_interactions(req.drug_name, req.other_drugs)
    allergy_warnings = check_allergies(req.drug_name, req.patient_allergies)

    has_block = any(w["severity"] == "block" for w in drug_warnings + allergy_warnings)

    return {
        "drug": req.drug_name,
        "drug_interactions": drug_warnings,
        "allergy_warnings": allergy_warnings,
        "has_block": has_block,
    }


@router.post("/check-bulk")
async def check_bulk_interactions(req: BulkCheckRequest):
    """Check all drugs in a prescription against each other and patient allergies."""
    all_warnings = []
    seen_pairs = set()

    for i, drug in enumerate(req.drugs):
        others = [d for j, d in enumerate(req.drugs) if j != i]

        # Drug-drug interactions (deduplicate pairs)
        for warning in check_interactions(drug, others):
            pair = tuple(sorted([warning["drug_a"].lower(), warning["drug_b"].lower()]))
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                all_warnings.append(warning)

        # Allergy warnings
        for warning in check_allergies(drug, req.patient_allergies):
            all_warnings.append(warning)

    # Duplicate-drug warnings (same active prescribed twice)
    all_warnings.extend(check_duplicates(req.drugs))

    has_block = any(w["severity"] == "block" for w in all_warnings)

    return {
        "drugs": req.drugs,
        "warnings": all_warnings,
        "has_block": has_block,
    }
