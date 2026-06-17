"""Drug formulary API:
- GET /api/drugs            → autocomplete list (DB-backed, single source of truth)
- /api/drugs/admin/*        → HIS-admin CRUD for the curated formulary
- /api/drugs/review-queue/* → AI findings awaiting admin curation (approve/dismiss)

All under /api/drugs, which nginx already routes to python-backend (no nginx change).
"""
from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .. import drug_repo
from ..drug_data import SORTED_GENERICS

router = APIRouter(prefix="/api/drugs", tags=["drugs"])


@router.get("")
def list_drug_names():
    """Generic names for the prescribe-tab autocomplete (readable, _ → space)."""
    try:
        rows = drug_repo.list_drugs()
        names = sorted(r["generic"] for r in rows)
        if not names:
            names = SORTED_GENERICS
    except Exception:
        names = SORTED_GENERICS
    return {"drugs": [n.replace("_", " ") for n in names]}


# ── Models ────────────────────────────────────────────────────────────────────

class DrugIn(BaseModel):
    generic: str
    classes: List[str] = []
    aliases: List[str] = []


class InteractionIn(BaseModel):
    generic_a: str
    generic_b: str
    severity: str
    description: str


class ClassInteractionIn(BaseModel):
    class_a: str
    class_b: str
    severity: str
    description: str


class AllergyMapIn(BaseModel):
    allergen: str
    drug_class: str


class ApproveIn(BaseModel):
    severity: Optional[str] = None
    description: Optional[str] = None


# ── Admin: drugs ──────────────────────────────────────────────────────────────

@router.get("/admin/drugs")
def admin_list_drugs():
    return drug_repo.list_drugs()


@router.post("/admin/drugs")
def admin_upsert_drug(body: DrugIn):
    return drug_repo.upsert_drug(body.generic, body.classes, body.aliases)


@router.delete("/admin/drugs")
def admin_delete_drug(generic: str):
    drug_repo.delete_drug(generic)
    return {"ok": True}


# ── Admin: specific interactions ──────────────────────────────────────────────

@router.get("/admin/interactions")
def admin_list_interactions():
    return drug_repo.list_interactions()


@router.post("/admin/interactions")
def admin_upsert_interaction(body: InteractionIn):
    return drug_repo.upsert_interaction(body.generic_a, body.generic_b, body.severity, body.description)


@router.delete("/admin/interactions/{row_id}")
def admin_delete_interaction(row_id: str):
    drug_repo.delete_interaction(row_id)
    return {"ok": True}


# ── Admin: class interactions ─────────────────────────────────────────────────

@router.get("/admin/class-interactions")
def admin_list_class_interactions():
    return drug_repo.list_class_interactions()


@router.post("/admin/class-interactions")
def admin_upsert_class_interaction(body: ClassInteractionIn):
    return drug_repo.upsert_class_interaction(body.class_a, body.class_b, body.severity, body.description)


@router.delete("/admin/class-interactions/{row_id}")
def admin_delete_class_interaction(row_id: str):
    drug_repo.delete_class_interaction(row_id)
    return {"ok": True}


# ── Admin: allergy map ────────────────────────────────────────────────────────

@router.get("/admin/allergy-map")
def admin_list_allergy_map():
    return drug_repo.list_allergy_map()


@router.post("/admin/allergy-map")
def admin_upsert_allergy_map(body: AllergyMapIn):
    return drug_repo.upsert_allergy_map(body.allergen, body.drug_class)


@router.delete("/admin/allergy-map/{row_id}")
def admin_delete_allergy_map(row_id: str):
    drug_repo.delete_allergy_map(row_id)
    return {"ok": True}


# ── Review queue (AI findings → admin curation) ───────────────────────────────

@router.get("/review-queue")
def review_queue(status: str = "pending"):
    return drug_repo.list_queue(status)


@router.post("/review-queue/{row_id}/approve")
def review_approve(row_id: str, body: ApproveIn):
    result = drug_repo.approve(row_id, body.severity, body.description)
    return {"ok": result is not None, "approved": result}


@router.post("/review-queue/{row_id}/dismiss")
def review_dismiss(row_id: str):
    drug_repo.dismiss(row_id)
    return {"ok": True}
