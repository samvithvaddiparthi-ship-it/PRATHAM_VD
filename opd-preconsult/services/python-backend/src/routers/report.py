import os
import re
import json
import uuid
import traceback
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
import anthropic

from ..db import query, execute
from ..auth import require_auth
from ..view_audit import record_view

router = APIRouter(prefix="/api/report", tags=["report"])

PROMPT_DIR = Path(__file__).parent.parent / "prompts"

class ReportRequest(BaseModel):
    session_id: str

@router.post("/generate")
async def generate_report(req: ReportRequest):
    try:
        return await _generate_report_impl(req)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[report.generate] ERROR for session {req.session_id}: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}")


async def _generate_report_impl(req: ReportRequest):
    # Gather all session data
    session = query("SELECT * FROM sessions WHERE id = %s", (req.session_id,))
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session = session[0]

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
    }

    # Generate report via LLM or fallback
    from ..llm_client import has_llm, complete as llm_complete
    report_md = None
    if has_llm():
        try:
            system_prompt = (PROMPT_DIR / "system_report.txt").read_text()
            user_content = json.dumps(session_json, indent=2, default=str)
            report_md = llm_complete(system_prompt, user_content, max_tokens=2048)
        except Exception as e:
            print(f"[report] LLM call failed: {type(e).__name__}: {e}", flush=True)
            report_md = None
    if not report_md:
        report_md = _fallback_report(session_json)

    # Build FHIR bundle
    fhir_bundle = _build_fhir_bundle(session, answers, vitals, all_doc_meds, all_doc_labs)

    # Store report
    execute(
        """INSERT INTO session_reports (session_id, report_md, report_json, fhir_bundle)
           VALUES (%s, %s, %s, %s)""",
        (req.session_id, report_md, json.dumps(session_json, default=str), json.dumps(fhir_bundle, default=str)),
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
async def submit_feedback(session_id: str, feedback: dict):
    val = feedback.get("feedback")
    if val not in ("accurate", "inaccurate"):
        raise HTTPException(status_code=400, detail="Feedback must be 'accurate' or 'inaccurate'")
    execute(
        "UPDATE session_reports SET doctor_feedback = %s WHERE session_id = %s",
        (val, session_id),
    )
    return {"stored": True}


@router.post("/{session_id}/edit")
async def edit_report(session_id: str, body: dict):
    """Store the doctor's full edited report markdown for the latest report. The AI
    original (report_md) is preserved untouched; the edited body lives in
    doctor_correction and is shown as the current report. Flags it inaccurate.
    An empty body clears the edit (reverts to the AI original)."""
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

    lines.append(f"\n## Chief Complaint & History\n{answers.get('q_chief_complaint', 'Not recorded')}")
    lines.append(f"\n## Vitals")
    if vitals:
        if bp_sys:
            lines.append(f"- BP: {bp_sys}/{vitals.get('bp_diastolic', '?')} mmHg")
        if vitals.get("weight_kg"):
            lines.append(f"- Weight: {vitals['weight_kg']} kg")
        if spo2:
            lines.append(f"- SpO2: {spo2}%")
        if vitals.get("heart_rate"):
            lines.append(f"- HR: {vitals['heart_rate']} bpm")
    else:
        lines.append("- Not recorded")

    # Medications: document-extracted (grouped by source), patient-reported only if it adds info
    lines.append("\n## Current/Prior Medications")
    doc_meds = session_json.get("medications_from_documents", [])
    patient_meds = answers.get("q_medications", "")
    if doc_meds:
        # Group drugs by their source prescription so the date appears once per group
        groups = {}
        for m in doc_meds:
            key = (m.get('source_doc_type', 'document'), m.get('source_date', ''))
            groups.setdefault(key, []).append(m)
        for (src_type, src_date), meds in groups.items():
            header = f"**From {src_type.replace('_', ' ')}"
            if src_date: header += f" dated {src_date}"
            header += ":**"
            lines.append(header)
            for m in meds:
                line = f"- {m['name']}"
                if m.get('dose'): line += f" {m['dose']}"
                if m.get('frequency'): line += f" — {m['frequency']}"
                if m.get('duration'): line += f", for {m['duration']}"
                if m.get('instructions'): line += f" ({m['instructions']})"
                lines.append(line)
    # Include any patient-reported meds not already covered by the documents,
    # listed plainly as bullets (no "patient also reported" prefix).
    if patient_meds and patient_meds.lower() not in ('none', 'nil', 'no', ''):
        doc_names = " ".join(m.get('name', '').lower() for m in doc_meds)
        reported = [t.strip() for t in re.split(r'[,;\n]', patient_meds) if t.strip()]
        new_terms = [t for t in reported if t.lower() not in doc_names]
        for term in new_terms:
            lines.append(f"- {term}")
    elif not doc_meds:
        lines.append("None")

    lines.append(f"\n## Allergies\n{answers.get('q_allergies', 'Not recorded')}")

    # Lab values from documents
    doc_labs = session_json.get("lab_values_from_documents", [])
    if doc_labs:
        lines.append("\n## Lab Results from Documents")
        lines.append("| Test | Value | Source |")
        lines.append("|------|-------|--------|")
        for l in doc_labs:
            lines.append(f"| {l['test']} | {l['value']} | {l.get('source_doc_type', '')} {l.get('source_date', '')} |")

    # Documents reviewed
    documents = session_json.get("documents", [])
    if documents:
        lines.append("\n## Documents Reviewed")
        for d in documents:
            dtype = d.get('type', 'unknown').replace('_', ' ').title()
            n_meds = len(d.get('medications', []))
            n_labs = len(d.get('lab_values', []))
            detail = []
            if n_meds: detail.append(f"{n_meds} medications")
            if n_labs: detail.append(f"{n_labs} lab values")
            detail_str = f" — extracted {', '.join(detail)}" if detail else ""
            lines.append(f"- **{dtype}**{detail_str}")

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
