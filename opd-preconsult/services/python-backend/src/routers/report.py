import os
import re
import json
import uuid
import logging
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
import anthropic

from ..db import query, execute
from ..auth import require_auth, enforce_ownership
from ..ratelimit import rate_limit
from ..view_audit import record_view

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/report", tags=["report"])

# §8c — report generation runs a cloud LLM; cap per client to limit cost-abuse.
_rl_report = rate_limit("report_generate", default_max=20, default_window=60)

PROMPT_DIR = Path(__file__).parent.parent / "prompts"

class ReportRequest(BaseModel):
    session_id: str
    # Regenerate even when a report already exists. Patient-flow callers omit this
    # (idempotent — reuse the existing report). Only the doctor's late-vitals path
    # sets it, because the vitals just changed and the report must reflect them.
    force: bool = False

@router.post("/generate", dependencies=[Depends(_rl_report)])
async def generate_report(req: ReportRequest, claims: dict = Depends(require_auth)):
    # §5c — a patient may only (re)generate their OWN report; clinicians any.
    enforce_ownership(claims, req.session_id)
    try:
        return await _generate_report_impl(req)
    except HTTPException:
        raise
    except Exception:
        # §4a — log full detail server-side; return a generic message so DB/driver
        # internals never reach the client.
        logger.exception("report.generate failed for session %s", req.session_id)
        raise HTTPException(status_code=500, detail="Internal server error")


async def _generate_report_impl(req: ReportRequest):
    # Gather all session data
    session = query("SELECT * FROM sessions WHERE id = %s", (req.session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session = session[0]

    # Is there already a report for this session? Generation runs up to three times
    # per visit (patient vitals page, patient done page, and again when a nurse adds
    # late vitals). Without this guard each call INSERTed a NEW session_reports row —
    # wasting an LLM call and, worse, orphaning doctor-attached data (scribe notes,
    # corrections, HIS-push status live on a specific row, so a fresh row makes them
    # vanish from view). We keep ONE row per session: reuse it when unchanged,
    # UPDATE it in place when forced.
    existing = query(
        "SELECT id, report_md, report_json, fhir_bundle FROM session_reports "
        "WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
        (req.session_id,),
    )
    existing = existing[0] if existing else None

    # A report already exists and no refresh was requested → return it untouched
    # (no LLM call, no new row). This is the common patient-flow case.
    if existing and not req.force:
        execute(
            "UPDATE sessions SET state = 'COMPLETE', updated_at = NOW() WHERE id = %s",
            (req.session_id,),
        )
        return {
            "report_md": existing["report_md"],
            "report_json": existing["report_json"],
            "fhir_bundle": existing["fhir_bundle"],
            "triage_level": session.get("triage_level") or "GREEN",
        }

    answers = query(
        """SELECT sa.question_id, sa.answer_raw, qn.text_en AS question_text
           FROM session_answers sa
           LEFT JOIN questionnaire_nodes qn
             ON qn.id = sa.question_id AND qn.department = %s
           WHERE sa.session_id = %s
           ORDER BY sa.created_at""",
        (session.get("department"), req.session_id),
    )

    vitals = query(
        "SELECT * FROM session_vitals WHERE session_id = %s ORDER BY recorded_at DESC LIMIT 1",
        (req.session_id,),
    )
    vitals = vitals[0] if vitals else {}

    # Load confirmed documents
    docs = query(
        "SELECT * FROM session_documents WHERE session_id = %s AND patient_confirmed = true ORDER BY created_at",
        (req.session_id,),
    )

    # Build structured document data grouped by type
    documents_data = []
    all_doc_meds = []
    all_doc_labs = []
    all_doc_allergies = []   # allergen -> source doc type (OCR-extracted, AI, needs verify)
    for doc in docs:
        structured = doc.get("ocr_structured") or {}
        if isinstance(structured, str):
            structured = json.loads(structured)

        doc_entry = {
            "type": doc.get("doc_type", "unknown"),
            "uploaded_at": str(doc.get("created_at", ""))[:10],  # date only (YYYY-MM-DD), no time
            "confidence": doc.get("ocr_confidence"),
            "raw_text_excerpt": (doc.get("ocr_raw") or "")[:500],
        }

        meds = structured.get("medications", [])
        if meds:
            doc_entry["medications"] = meds
            for m in meds:
                m["source_doc_type"] = doc.get("doc_type")
                m["source_date"] = str(doc.get("created_at", ""))[:10]
            all_doc_meds.extend(meds)

        labs = structured.get("lab_values", [])
        if labs:
            doc_entry["lab_values"] = labs
            for l in labs:
                l["source_doc_type"] = doc.get("doc_type")
                l["source_date"] = str(doc.get("created_at", ""))[:10]
            all_doc_labs.extend(labs)

        allergies = [str(a).strip() for a in (structured.get("allergies") or []) if str(a).strip()]
        if allergies:
            doc_entry["allergies"] = allergies
            for a in allergies:
                all_doc_allergies.append({"allergen": a, "source_doc_type": doc.get("doc_type")})

        # High-value clinical context the OCR already extracts but that was being
        # dropped before reaching the report LLM. These feed the interpretive
        # sections directly — diagnosis/clinical_notes/investigations into Past
        # Medical History (the prompt already asks for discharge-summary findings
        # there), doctor_name for provenance of the prior encounter. Included only
        # when present so absent fields don't clutter the prompt. (PHI note: this
        # goes to the cloud LLM alongside the patient name already in the prompt;
        # the §3 pseudonymisation concern is deferred to the Vertex migration.)
        diagnosis = structured.get("diagnosis")
        if diagnosis and str(diagnosis).strip():
            doc_entry["diagnosis"] = str(diagnosis).strip()

        clinical_notes = structured.get("clinical_notes")
        if clinical_notes and str(clinical_notes).strip():
            doc_entry["clinical_notes"] = str(clinical_notes).strip()

        investigations = [str(i).strip() for i in (structured.get("investigations_ordered") or []) if str(i).strip()]
        if investigations:
            doc_entry["investigations_ordered"] = investigations

        doctor_name = structured.get("doctor_name")
        if doctor_name and str(doctor_name).strip():
            doc_entry["doctor_name"] = str(doctor_name).strip()

        documents_data.append(doc_entry)

    # Build session JSON for the LLM
    session_json = {
        "patient": {
            "name": session.get("patient_name"),
            "age": session.get("patient_age"),
            "gender": session.get("patient_gender"),
            "department": session.get("department"),
        },
        "answers": {a["question_id"]: a["answer_raw"] for a in answers},
        "qa": [
            {"question": a.get("question_text") or a["question_id"], "answer": a["answer_raw"]}
            for a in answers
        ],
        "vitals": {k: v for k, v in vitals.items() if k not in ("id", "session_id", "recorded_at", "source")} if vitals else {},
        "triage_level": session.get("triage_level"),
        "documents": documents_data,
        "medications_from_documents": all_doc_meds,
        "lab_values_from_documents": all_doc_labs,
        "allergies_from_documents": all_doc_allergies,
    }
    # Structure the patient's free-text/spoken medications answer (Bhashini NMT +
    # LLM extraction) so their greeting and full sentence never surface as meds in
    # the report or the doctor's medication list — only the actual medicines do.
    session_json["medications_from_patient"] = _extract_patient_meds(
        _base_answer(session_json["answers"], "medications") or ""
    )
    # Same treatment for the patient's spoken/typed allergies answer (Bhashini NMT +
    # LLM extraction) so a Hindi/Telugu sentence with a greeting doesn't surface
    # verbatim as the allergy list — only the actual allergens do.
    session_json["allergies_from_patient"] = _extract_patient_allergies(
        _base_answer(session_json["answers"], "allergies") or ""
    )

    # Generate report. HYBRID: the LLM writes ONLY the interpretive sections
    # (Quick Summary, Chief Complaint & History, Past Medical History, Lab Results).
    # The exact pass-through sections (Medications, Allergies, Vitals, Documents
    # Reviewed) are rendered verbatim from the data in Python — never sent through
    # the LLM — so they can't be paraphrased/hallucinated and cost no output tokens.
    from ..llm_client import has_llm, complete as llm_complete
    report_md = None
    if has_llm():
        try:
            system_prompt = (PROMPT_DIR / "system_report.txt").read_text()
            # Department-specific emphasis (admin-editable, migration 029). Appended
            # to the base prompt so the SAME fixed section schema is reused for every
            # department — this only reshapes prioritisation/wording, never the
            # structure or the no-fabrication rule (spelled out in the wrapper below).
            focus = _department_report_focus(session.get("department"))
            if focus:
                system_prompt += (
                    f"\n\n## Department focus — {session.get('department')}\n"
                    "The following is specialty-specific emphasis for this department. "
                    "Apply it ONLY to what you prioritise and how you word the four "
                    "sections above. It must NOT add, rename, drop, or reorder any "
                    "section, and it can NEVER override the rule against inferring or "
                    "fabricating clinical information.\n\n"
                    f"{focus}"
                )
            user_content = json.dumps(session_json, indent=2, default=str)
            # When no documents were scanned (OCR off, or nothing uploaded), tell the
            # model plainly so it can't reference or invent prescription/lab/document
            # content anywhere in the interpretive sections.
            if not session_json.get("documents"):
                user_content += (
                    "\n\nNOTE: No documents were scanned for this visit. Do NOT mention, "
                    "infer, or fabricate any prescription, uploaded-document, or lab-report "
                    "data anywhere. Base the summary ONLY on the questionnaire answers and vitals."
                )
            llm_md = llm_complete(system_prompt, user_content, max_tokens=2048)
            # Use hybrid assembly only if the LLM returned recognizable sections;
            # otherwise fall through to the full deterministic report.
            if llm_md and _split_llm_sections(llm_md):
                report_md = _assemble_report(llm_md, session_json)
        except Exception:
            logger.warning("report LLM call failed; falling back to deterministic report", exc_info=True)
            report_md = None
    if not report_md:
        report_md = _fallback_report(session_json)

    # Build FHIR bundle
    fhir_bundle = _build_fhir_bundle(session, answers, vitals, all_doc_meds, all_doc_labs)

    # Store report — UPDATE the existing row in place (preserving doctor_feedback,
    # doctor_correction, scribe_*, his_pushed on that row) when regenerating, or
    # INSERT the first one. Keeps at most one report row per session.
    report_json_s = json.dumps(session_json, default=str)
    fhir_s = json.dumps(fhir_bundle, default=str)
    if existing:
        execute(
            "UPDATE session_reports SET report_md = %s, report_json = %s, fhir_bundle = %s WHERE id = %s",
            (report_md, report_json_s, fhir_s, existing["id"]),
        )
    else:
        execute(
            """INSERT INTO session_reports (session_id, report_md, report_json, fhir_bundle)
               VALUES (%s, %s, %s, %s)""",
            (req.session_id, report_md, report_json_s, fhir_s),
        )

    # Update session state
    execute(
        "UPDATE sessions SET state = 'COMPLETE', updated_at = NOW() WHERE id = %s",
        (req.session_id,),
    )

    return {
        "report_md": report_md,
        "report_json": session_json,
        "fhir_bundle": fhir_bundle,
        "triage_level": session.get("triage_level") or "GREEN",
    }


@router.get("/{session_id}")
async def get_report(session_id: str, claims: dict = Depends(require_auth)):
    enforce_ownership(claims, session_id)  # §5c
    reports = query(
        "SELECT * FROM session_reports WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    )
    if not reports:
        raise HTTPException(status_code=404, detail="Report not found")
    # B7 access audit: record that this clinician viewed the patient's record
    # (deduped + non-blocking; never affects the response).
    record_view(session_id, claims)
    r = reports[0]
    return {
        "report_md": r["report_md"],
        "report_json": r["report_json"],
        "fhir_bundle": r["fhir_bundle"],
        "his_pushed": r["his_pushed"],
        "doctor_feedback": r["doctor_feedback"],
        "doctor_correction": r.get("doctor_correction"),
        "corrected_at": r.get("corrected_at"),
    }


@router.post("/{session_id}/feedback")
async def submit_feedback(session_id: str, feedback: dict, claims: dict = Depends(require_auth)):
    enforce_ownership(claims, session_id)  # §5c
    val = feedback.get("feedback")
    if val not in ("accurate", "inaccurate"):
        raise HTTPException(status_code=400, detail="Feedback must be 'accurate' or 'inaccurate'")
    execute(
        "UPDATE session_reports SET doctor_feedback = %s WHERE session_id = %s",
        (val, session_id),
    )
    return {"stored": True}


@router.post("/{session_id}/edit")
async def edit_report(session_id: str, body: dict, claims: dict = Depends(require_auth)):
    """Store the doctor's full edited report markdown for the latest report. The AI
    original (report_md) is preserved untouched; the edited body lives in
    doctor_correction and is shown as the current report. Flags it inaccurate.
    An empty body clears the edit (reverts to the AI original)."""
    enforce_ownership(claims, session_id)  # §5c
    edited = (body.get("report_md") or "").strip()
    rows = query(
        "SELECT id FROM session_reports WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Report not found")
    execute(
        """UPDATE session_reports
           SET doctor_correction = %s, corrected_at = NOW(), doctor_feedback = 'inaccurate'
           WHERE id = %s""",
        (edited or None, rows[0]["id"]),
    )
    return {"stored": True}


# ── Deterministic section renderers ──────────────────────────────────────────
# These sections are exact pass-through of patient/nurse-entered data (vitals,
# allergies) or OCR-extracted structured data (medications, documents). They are
# rendered verbatim in Python — NEVER sent through the LLM — so the numbers/text
# in the report are guaranteed to match what was entered (no paraphrase or
# hallucination risk) and cost zero tokens. Shared by BOTH the LLM/hybrid path
# and the no-LLM fallback so the two always produce identical pass-through blocks.

def _department_report_focus(dept_code):
    """Specialty-specific report emphasis for a department (migration 029),
    admin-editable in HIS. Returns the trimmed focus text, or None when unset or
    when the departments table isn't present (older deployments) — the caller then
    uses the base prompt unchanged. Never raises: a lookup failure must not block
    report generation."""
    if not dept_code:
        return None
    try:
        rows = query("SELECT report_focus FROM departments WHERE code = %s", (dept_code,))
    except Exception:
        logger.warning("department report_focus lookup failed; using base prompt", exc_info=True)
        return None
    if not rows:
        return None
    focus = (rows[0].get("report_focus") or "").strip()
    return focus or None


def _base_answer(answers, role):
    """Resolve a BASE questionnaire answer by its role, i.e. the id suffix after
    '_base_'. Base questions are namespaced per department (q_<dept>_base_<role>,
    e.g. q_card_base_chief_complaint), so we match the suffix rather than a fixed
    id — otherwise a hardcoded 'q_chief_complaint' never matches and the field
    always reads 'Not recorded'. Falls back to a bare 'q_<role>' for safety."""
    suffix = f"_base_{role}"
    for qid, val in (answers or {}).items():
        if qid.endswith(suffix) and str(val).strip():
            return val
    bare = (answers or {}).get(f"q_{role}")
    return bare if bare and str(bare).strip() else None


# Devanagari / Telugu Unicode blocks — detect the script of the patient's own
# free-text so we translate it before extracting (Bhashini NMT needs a source lang).
def _script_lang(text: str) -> str:
    for ch in text or "":
        o = ord(ch)
        if 0x0900 <= o <= 0x097F:
            return "hi"
        if 0x0C00 <= o <= 0x0C7F:
            return "te"
    return "en"


def _parse_med_json(out: str) -> list:
    """Best-effort parse of the extractor's JSON array (tolerate code fences/prose)."""
    s = (out or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s).rstrip("`").strip()
    m = re.search(r"\[.*\]", s, re.DOTALL)
    if m:
        s = m.group(0)
    try:
        data = json.loads(s)
    except Exception:
        return []
    return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []


def _extract_patient_meds(text: str) -> dict:
    """Turn the patient's free-text/spoken 'what medicines are you taking' answer
    into a structured list, so their greeting and rambling sentence never leak into
    the report or the doctor's medication list as if they were medicines.

    Pipeline: Bhashini NMT (the same 'Show translation' path the patient app uses)
    to English, then an LLM extraction that keeps only real medicines. Returns
    {"items": [{"name","dose","generic"}], "parsed": bool, "raw": str, "english": str}.
    'parsed' is False when the AI is unavailable or found nothing — the caller then
    shows the raw text once as a labelled, unverified note (never as clean meds)."""
    raw = (text or "").strip()
    if not raw or raw.lower() in ("none", "nil", "no", "n/a", "-"):
        return {"items": [], "parsed": True, "raw": "", "english": ""}

    # 1) Translate to English via Bhashini NMT (deterministic, on-shore) when the
    #    answer is in an Indian script. Best-effort — fall back to the raw text.
    english = raw
    lang = _script_lang(raw)
    if lang in ("hi", "te"):
        try:
            from ..bhashini import asr
            if asr.have_keys():
                english = asr.translate(raw, lang, "en") or raw
        except Exception:
            logger.warning("patient-med translation failed; using raw text", exc_info=True)
    english_out = english if english != raw else ""

    # 2) LLM-extract structured medicines from the (now English) text.
    from ..llm_client import has_llm, complete as llm_complete
    if not has_llm():
        return {"items": [], "parsed": False, "raw": raw, "english": english_out}
    try:
        prompt = (PROMPT_DIR / "extract_patient_meds.txt").read_text()
        items = _parse_med_json(llm_complete(prompt, english, max_tokens=512))
    except Exception:
        logger.warning("patient-med extraction failed", exc_info=True)
        return {"items": [], "parsed": False, "raw": raw, "english": english_out}
    if not items:
        return {"items": [], "parsed": False, "raw": raw, "english": english_out}

    from ..drug_data import normalize_drug_name
    cleaned = []
    for m in items:
        name = str(m.get("name", "")).strip()
        if not name:
            continue
        generic = ""
        try:
            g = normalize_drug_name(name)
            if g and g.lower() != name.lower():
                generic = g
        except Exception:
            pass
        cleaned.append({"name": name, "dose": str(m.get("dose", "") or "").strip(), "generic": generic})
    return {"items": cleaned, "parsed": bool(cleaned), "raw": raw, "english": english_out}


def _parse_str_list_json(out: str) -> list:
    """Best-effort parse of a JSON array of strings (tolerate code fences/prose)."""
    s = (out or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\n?", "", s).rstrip("`").strip()
    m = re.search(r"\[.*\]", s, re.DOTALL)
    if m:
        s = m.group(0)
    try:
        data = json.loads(s)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [str(x).strip() for x in data if str(x).strip()]


def _extract_patient_allergies(text: str) -> dict:
    """Turn the patient's free-text/spoken 'what are you allergic to' answer into a
    structured allergen list, so their greeting and rambling sentence never surface
    verbatim in the Allergies section of the report or the doctor's view.

    Same pipeline as _extract_patient_meds: Bhashini NMT to English (when the answer
    is in an Indian script), then an LLM extraction that keeps only real allergens.
    Returns {"items": [<allergen str>], "parsed": bool, "raw": str, "english": str}.
    'parsed' is False when the AI is unavailable; the caller then shows the raw text
    once as a labelled, unverified note (never as clean, confirmed allergens)."""
    raw = (text or "").strip()
    if not raw or raw.lower() in ("none", "nil", "no", "n/a", "-", "no allergies", "nkda"):
        return {"items": [], "parsed": True, "raw": "", "english": ""}

    # 1) Translate to English via Bhashini NMT when the answer is in an Indian
    #    script. Best-effort — fall back to the raw text.
    english = raw
    lang = _script_lang(raw)
    if lang in ("hi", "te"):
        try:
            from ..bhashini import asr
            if asr.have_keys():
                english = asr.translate(raw, lang, "en") or raw
        except Exception:
            logger.warning("patient-allergy translation failed; using raw text", exc_info=True)
    english_out = english if english != raw else ""

    # 2) LLM-extract the allergen names from the (now English) text.
    from ..llm_client import has_llm, complete as llm_complete
    if not has_llm():
        return {"items": [], "parsed": False, "raw": raw, "english": english_out}
    try:
        prompt = (PROMPT_DIR / "extract_patient_allergies.txt").read_text()
        items = _parse_str_list_json(llm_complete(prompt, english, max_tokens=256))
    except Exception:
        logger.warning("patient-allergy extraction failed", exc_info=True)
        return {"items": [], "parsed": False, "raw": raw, "english": english_out}
    return {"items": items, "parsed": bool(items), "raw": raw, "english": english_out}


def _render_medications(session_json) -> str:
    """## Current/Prior Medications — grouped by source prescription (OCR), plus the
    patient's own reported meds (structured by _extract_patient_meds so greetings and
    filler are dropped). 'None' if empty."""
    doc_meds = session_json.get("medications_from_documents", [])
    lines = ["## Current/Prior Medications"]
    if doc_meds:
        groups = {}
        for m in doc_meds:
            key = (m.get('source_doc_type', 'document'), m.get('source_date', ''))
            groups.setdefault(key, []).append(m)
        for (src_type, src_date), meds in groups.items():
            header = f"**From {src_type.replace('_', ' ')}"
            if src_date:
                header += f" dated {src_date}"
            header += ":**"
            lines.append("")          # blank line so the bold header renders as its
            lines.append(header)      # own block, not a continuation of the last bullet
            for m in meds:
                line = f"- {m['name']}"
                if m.get('dose'):         line += f" {m['dose']}"
                if m.get('frequency'):    line += f" — {m['frequency']}"
                if m.get('duration'):     line += f", for {m['duration']}"
                if m.get('instructions'): line += f" ({m['instructions']})"
                lines.append(line)

    doc_names = " ".join(m.get('name', '').lower() for m in doc_meds)
    pm = session_json.get("medications_from_patient") or {"items": [], "parsed": True, "raw": "", "english": ""}
    new_items = [it for it in pm.get("items", [])
                 if it.get("name", "").lower() not in doc_names
                 and not (it.get("generic") and it["generic"].lower() in doc_names)]
    if new_items:
        # Labelled so the doctor can tell these from the OCR'd prescription meds
        # above: self-reported by the patient at intake, not read off a document.
        lines.append("")
        lines.append("**Reported by patient (spoken/typed at intake):**")
        for it in new_items:
            line = f"- {it['name']}"
            if it.get("dose"):    line += f" {it['dose']}"
            if it.get("generic"): line += f" ({it['generic']})"
            lines.append(line)
    elif pm.get("raw") and not pm.get("parsed"):
        # Couldn't parse it into medicines (AI unavailable, or nothing recognised) —
        # show it once, clearly flagged for the doctor to read, never as clean meds.
        note = pm.get("english") or pm.get("raw")
        lines.append("")
        lines.append("**Reported by patient (unverified — please review):**")
        lines.append(f"- {note}")

    if len(lines) == 1:               # heading only — nothing from documents or patient
        lines.append("None")
    return "\n".join(lines)


def _render_allergies(session_json) -> str:
    """## Allergies — the patient's own answer, structured by _extract_patient_allergies
    (Bhashini NMT + LLM) so a spoken Hindi/Telugu sentence with a greeting is reduced
    to the actual allergens, never surfaced verbatim. When the AI can't parse it, the
    raw/translated text is shown once, clearly flagged as unverified. Any allergies
    OCR-extracted from uploaded documents are listed SEPARATELY and clearly labelled
    'from uploaded <doc> — AI-extracted, verify', never merged into the patient-stated
    line. Document allergies de-duplicate against the patient-stated text."""
    pa = session_json.get("allergies_from_patient") or {"items": [], "parsed": True, "raw": "", "english": ""}
    lines = ["## Allergies"]
    if pa.get("items"):
        for a in pa["items"]:
            lines.append(f"- {a}")
    elif pa.get("raw") and not pa.get("parsed"):
        # Couldn't parse it into allergens (AI unavailable, or nothing recognised) —
        # show it once, clearly flagged for the doctor to read, never as clean allergies.
        note = pa.get("english") or pa.get("raw")
        lines.append(f"- {note} (unverified — please review)")
    else:
        lines.append("Not recorded")

    # De-dup document allergens against everything the patient stated (structured
    # items + the raw/translated text, so a match is caught either way).
    stated_lc = " ".join([*(pa.get("items") or []), pa.get("raw", ""), pa.get("english", "")]).lower()
    seen = set()
    for a in session_json.get("allergies_from_documents", []):
        allergen = str(a.get("allergen", "")).strip()
        if not allergen:
            continue
        key = allergen.lower()
        # Skip if the patient already stated it, or a duplicate across documents.
        if key in seen or key in stated_lc:
            continue
        seen.add(key)
        src = str(a.get("source_doc_type", "document")).replace("_", " ")
        lines.append(f"- {allergen} (from uploaded {src} — AI-extracted, verify)")
    return "\n".join(lines)


def _render_vitals(vitals) -> str:
    """## Vitals — each recorded vital, verbatim, one bullet per line."""
    vitals = vitals or {}
    b = []
    bp_sys = vitals.get("bp_systolic")
    if bp_sys:
        b.append(f"- BP: {bp_sys}/{vitals.get('bp_diastolic', '?')} mmHg")
    if vitals.get("weight_kg"):     b.append(f"- Weight: {vitals['weight_kg']} kg")
    if vitals.get("spo2_pct"):      b.append(f"- SpO2: {vitals['spo2_pct']}%")
    if vitals.get("heart_rate"):    b.append(f"- HR: {vitals['heart_rate']} bpm")
    if vitals.get("temperature_c"): b.append(f"- Temp: {vitals['temperature_c']} °C")
    return "## Vitals\n" + ("\n".join(b) if b else "- Not recorded")


def _render_documents_reviewed(documents) -> str:
    """## Documents Reviewed — one bullet per uploaded document (type + extracted
    counts). Returns '' (section omitted) when nothing was uploaded."""
    documents = documents or []
    if not documents:
        return ""
    lines = ["## Documents Reviewed"]
    for d in documents:
        dtype = d.get('type', 'unknown').replace('_', ' ').title()
        n_meds = len(d.get('medications', []))
        n_labs = len(d.get('lab_values', []))
        n_alg = len(d.get('allergies', []))
        detail = []
        if n_meds: detail.append(f"{n_meds} medications")
        if n_labs: detail.append(f"{n_labs} lab values")
        if n_alg: detail.append(f"{n_alg} allergies")
        detail_str = f" — extracted {', '.join(detail)}" if detail else ""
        lines.append(f"- **{dtype}**{detail_str}")
    return "\n".join(lines)


# ── Hybrid assembly ──────────────────────────────────────────────────────────
_REPORT_FOOTER = (
    "---\n*Generated by OPD Pre-Consultation AI. This is a data summary for "
    "clinical use. The doctor should verify all information directly with the patient.*"
)
# The only headings the LLM is asked to write. Anything else it emits (a stray
# pass-through section, a footer) is dropped so it can't duplicate our verbatim
# sections.
_LLM_HEADINGS = {
    "quick summary",
    "chief complaint & history",
    "past medical history",
    "lab results from documents",
}


def _split_llm_sections(md: str) -> dict:
    """Split the LLM markdown into {normalized_heading: raw_section_text}, keeping
    only the sections the LLM is supposed to own."""
    sections = {}
    key, buf = None, []
    for line in (md or "").splitlines():
        if line.lstrip().startswith("## "):
            if key is not None:
                sections[key] = "\n".join(buf).rstrip()
            key = line.lstrip()[3:].strip().lower()
            buf = [line.strip()]
        elif key is not None:
            buf.append(line)
    if key is not None:
        sections[key] = "\n".join(buf).rstrip()
    # Keep only the LLM's own headings, and only when they actually have body
    # content below the heading line — this drops empty sections the model
    # sometimes emits (e.g. a bare "## Lab Results from Documents" with no table).
    result = {}
    for k, v in sections.items():
        if k not in _LLM_HEADINGS:
            continue
        body = "\n".join(v.splitlines()[1:]).strip()
        if body:
            result[k] = v
    return result


def _assemble_report(llm_md, session_json) -> str:
    """Weave the LLM's interpretive sections together with the Python-rendered
    pass-through sections, in the canonical on-screen order."""
    answers = session_json.get("answers", {})
    llm = _split_llm_sections(llm_md)
    parts = []
    # Interpretive (LLM), in order, if present.
    for k in ("quick summary", "chief complaint & history", "past medical history"):
        if llm.get(k):
            parts.append(llm[k])
    # Verbatim pass-through (Python) — always present.
    parts.append(_render_medications(session_json))
    parts.append(_render_allergies(session_json))
    parts.append(_render_vitals(session_json.get("vitals", {})))
    # Lab results table (LLM) — ONLY when real OCR-extracted lab data exists.
    # This is what removes the OCR-derived lab section when OCR is off (uploaded
    # docs stay unconfirmed → no lab data reaches the report) or when nothing was
    # uploaded, and it stops the model fabricating an empty/hallucinated table.
    if session_json.get("lab_values_from_documents") and llm.get("lab results from documents"):
        parts.append(llm["lab results from documents"])
    # Documents reviewed (Python) — omitted when nothing uploaded.
    docs = _render_documents_reviewed(session_json.get("documents", []))
    if docs:
        parts.append(docs)
    return "\n\n".join(parts) + "\n\n" + _REPORT_FOOTER


def _fallback_report(session_json):
    """Generate a basic report without LLM"""
    answers = session_json.get("answers", {})
    vitals = session_json.get("vitals", {})
    patient = session_json.get("patient", {})
    triage = session_json.get("triage_level", "GREEN")

    lines = ["## QUICK SUMMARY"]
    if triage == "RED":
        lines.append("- 🚨 **SEVERE** — Patient flagged for immediate review")
    if answers.get("q_chest_pain") == "yes":
        lines.append("- 🚨 Chest pain reported")
    if answers.get("q_chest_pain_radiation") == "yes":
        lines.append("- 🚨 Chest pain with radiation — possible ACS")
    bp_sys = vitals.get("bp_systolic")
    if bp_sys and bp_sys > 140:
        lines.append(f"- ⚠ BP {bp_sys}/{vitals.get('bp_diastolic', '?')} — elevated")
    spo2 = vitals.get("spo2_pct")
    if spo2 and spo2 < 95:
        lines.append(f"- ⚠ SpO2 {spo2}% — low")
    if not any("🚨" in l or "⚠" in l for l in lines[1:]):
        lines.append("- Mild presentation, no critical flags")

    cc = _base_answer(answers, "chief_complaint")
    lines.append(f"\n## Chief Complaint & History\n{cc if cc else 'Not recorded'}")

    # Deterministic pass-through sections — SAME renderers the LLM/hybrid path uses,
    # in the same canonical order (Medications → Allergies → Vitals), so a no-LLM
    # report is identical to a hybrid one for these sections.
    lines.append("\n" + _render_medications(session_json))
    lines.append("\n" + _render_allergies(session_json))
    lines.append("\n" + _render_vitals(vitals))

    # Lab values from documents (simple table; no LLM in the fallback path)
    doc_labs = session_json.get("lab_values_from_documents", [])
    if doc_labs:
        lines.append("\n## Lab Results from Documents")
        lines.append("| Test | Value | Source |")
        lines.append("|------|-------|--------|")
        for l in doc_labs:
            lines.append(f"| {l['test']} | {l['value']} | {l.get('source_doc_type', '')} {l.get('source_date', '')} |")

    docs_section = _render_documents_reviewed(session_json.get("documents", []))
    if docs_section:
        lines.append("\n" + docs_section)

    lines.append("\n---")
    lines.append("*Generated by OPD Pre-Consultation AI. The doctor should verify all information.*")
    return "\n".join(lines)


# ICD-10 mapping for common OPD symptoms (question_id -> answer -> ICD-10 code + display)
ICD10_MAP = {
    "q_chest_pain": {"yes": {"code": "R07.9", "display": "Chest pain, unspecified"}},
    "q_chest_pain_radiation": {"yes": {"code": "I20.9", "display": "Angina pectoris, unspecified"}},
    "q_breathlessness": {
        "at_rest": {"code": "R06.0", "display": "Dyspnea"},
        "on_exertion": {"code": "R06.0", "display": "Dyspnea"},
    },
    "q_syncope": {"yes": {"code": "R55", "display": "Syncope and collapse"}},
    "q_palpitations": {"yes": {"code": "R00.2", "display": "Palpitations"}},
    "q_fever": {"yes": {"code": "R50.9", "display": "Fever, unspecified"}},
    "q_cough": {"yes": {"code": "R05", "display": "Cough"}},
    "q_headache": {"yes": {"code": "R51", "display": "Headache"}},
    "q_abdominal_pain": {"yes": {"code": "R10.9", "display": "Unspecified abdominal pain"}},
    "q_nausea": {"yes": {"code": "R11.0", "display": "Nausea"}},
    "q_vomiting": {"yes": {"code": "R11.1", "display": "Vomiting"}},
    "q_diarrhea": {"yes": {"code": "R19.7", "display": "Diarrhea, unspecified"}},
    "q_fatigue": {"yes": {"code": "R53.83", "display": "Other fatigue"}},
    "q_dizziness": {"yes": {"code": "R42", "display": "Dizziness and giddiness"}},
    "q_swelling": {"yes": {"code": "R60.9", "display": "Edema, unspecified"}},
    "q_weight_loss": {"yes": {"code": "R63.4", "display": "Abnormal weight loss"}},
    "q_joint_pain": {"yes": {"code": "M25.50", "display": "Pain in unspecified joint"}},
    "q_back_pain": {"yes": {"code": "M54.9", "display": "Dorsalgia, unspecified"}},
    "q_urinary_issues": {"yes": {"code": "R39.9", "display": "Unspecified symptoms involving urinary system"}},
    "q_skin_rash": {"yes": {"code": "R21", "display": "Rash and other nonspecific skin eruption"}},
    "q_diabetes": {"yes": {"code": "E11.9", "display": "Type 2 diabetes mellitus without complications"}},
    "q_hypertension": {"yes": {"code": "I10", "display": "Essential (primary) hypertension"}},
}


def _build_fhir_bundle(session, answers, vitals, doc_meds=None, doc_labs=None):
    """Build a minimal FHIR R4 Bundle with ICD-10 coding"""
    patient_id = str(session.get("id"))
    entries = []

    # Patient resource
    entries.append({
        "resource": {
            "resourceType": "Patient",
            "id": patient_id,
            "name": [{"text": session.get("patient_name", "Unknown")}],
            "gender": {"M": "male", "F": "female"}.get(session.get("patient_gender"), "unknown"),
            "telecom": [{"system": "phone", "value": session.get("patient_phone", "")}],
        }
    })

    # Vitals as Observations
    if vitals:
        if vitals.get("bp_systolic"):
            entries.append({
                "resource": {
                    "resourceType": "Observation",
                    "status": "final",
                    "code": {"coding": [{"system": "http://loinc.org", "code": "85354-9", "display": "Blood pressure"}]},
                    "component": [
                        {"code": {"coding": [{"code": "8480-6", "display": "Systolic"}]}, "valueQuantity": {"value": vitals["bp_systolic"], "unit": "mmHg"}},
                        {"code": {"coding": [{"code": "8462-4", "display": "Diastolic"}]}, "valueQuantity": {"value": vitals.get("bp_diastolic"), "unit": "mmHg"}},
                    ],
                }
            })
        if vitals.get("spo2_pct"):
            entries.append({
                "resource": {
                    "resourceType": "Observation",
                    "status": "final",
                    "code": {"coding": [{"system": "http://loinc.org", "code": "2708-6", "display": "SpO2"}]},
                    "valueQuantity": {"value": vitals["spo2_pct"], "unit": "%"},
                }
            })

    # Conditions from answers — with ICD-10 coding
    answers_dict = {a["question_id"]: a["answer_raw"] for a in answers} if isinstance(answers, list) else answers
    for qid, answer_val in answers_dict.items():
        if qid in ICD10_MAP and answer_val in ICD10_MAP[qid]:
            icd = ICD10_MAP[qid][answer_val]
            entries.append({
                "resource": {
                    "resourceType": "Condition",
                    "clinicalStatus": {"coding": [{"code": "active"}]},
                    "code": {
                        "coding": [{"system": "http://hl7.org/fhir/sid/icd-10", "code": icd["code"], "display": icd["display"]}],
                        "text": icd["display"],
                    },
                    "subject": {"reference": f"Patient/{patient_id}"},
                }
            })

    # MedicationStatements from documents
    for med in (doc_meds or []):
        dosage_parts = [
            med.get("dose"),
            med.get("frequency"),
            f"for {med['duration']}" if med.get("duration") else None,
            f"({med['instructions']})" if med.get("instructions") else None,
        ]
        dosage_text = " ".join(p for p in dosage_parts if p).strip()
        entries.append({
            "resource": {
                "resourceType": "MedicationStatement",
                "status": "active",
                "medicationCodeableConcept": {"text": med.get("name", "")},
                "subject": {"reference": f"Patient/{patient_id}"},
                "dosage": [{"text": dosage_text}] if dosage_text else [],
            }
        })

    # Observations from document lab values
    for lab in (doc_labs or []):
        entries.append({
            "resource": {
                "resourceType": "Observation",
                "status": "final",
                "code": {"text": lab.get("test", "")},
                "valueQuantity": {"value": lab.get("value")},
            }
        })

    return {
        "resourceType": "Bundle",
        "type": "collection",
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "entry": entries,
    }
