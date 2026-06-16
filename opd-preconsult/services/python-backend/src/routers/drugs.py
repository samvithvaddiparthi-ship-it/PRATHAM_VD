"""Drug formulary endpoint — serves the generic drug list to the frontend
autocomplete so there is a single source of truth (drug_data.GENERIC_DRUGS)
instead of a hardcoded copy in the UI."""
from fastapi import APIRouter

from ..drug_data import SORTED_GENERICS

router = APIRouter(prefix="/api/drugs", tags=["drugs"])


@router.get("")
def list_drugs():
    # Readable names for display (underscores → spaces); the backend normaliser
    # handles either form when matching.
    return {"drugs": [name.replace("_", " ") for name in SORTED_GENERICS]}
