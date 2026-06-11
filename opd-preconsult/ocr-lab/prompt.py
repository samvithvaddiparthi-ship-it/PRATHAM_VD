"""
Extraction prompt + JSON parser for the OCR test lab.

NOTE: VISION_EXTRACTION_PROMPT and _parse_llm_json are copied verbatim from
services/python-backend/src/routers/ocr.py so the lab is self-contained AND so
the local-vs-cloud comparison uses the exact same prompt the real app uses.
If the app's prompt changes, update this copy to keep the comparison faithful.
"""
import json
from typing import Optional

VISION_EXTRACTION_PROMPT = """You are a medical document extraction specialist for Indian hospitals.
Carefully examine the medical document image and extract ALL information with high precision.

First classify the document, then extract accordingly.

Document types:
- prescription: doctor's handwritten or printed Rx with medications
- lab_report: pathology / blood test results with numerical values
- discharge_summary: hospital discharge document with diagnosis and treatment
- diagnostic_report: ECG, Echo, X-Ray, MRI, or similar imaging/cardiology report
- unknown: cannot determine

For PRESCRIPTION — extract EVERY medication including Indian brand names (Crocin, Dolo, Augmentin, Pan-D, Ecosprin, Atorfit, Telma, Stamlo, Metpure, Cardace, etc.):
  name, generic name (if inferable), dose (e.g. 500mg), frequency (OD/BD/TDS/QID/HS/SOS), duration (e.g. 5 Days), route (oral/IV/topical/inhaled), instructions (before food / after food / with water).
  Also capture: doctor name, date, diagnosis or chief complaint, investigations ordered (CBC, ECG, Echo, X-Ray, etc.).

For LAB_REPORT — extract EVERY result row:
  test name, exact numeric value, unit, reference range exactly as printed, abnormal flag (true if outside the printed range).
  Also capture: lab name, report date, referring doctor name.

For DISCHARGE_SUMMARY — extract:
  primary diagnosis and all comorbidities, medications at discharge (same fields as prescription), key in-hospital investigation findings, follow-up date and instructions, any procedure or surgery performed.

For DIAGNOSTIC_REPORT — extract:
  report type (ECG/Echo/X-Ray/MRI/etc.), key findings with measurements, overall impression or conclusion.

Handwriting rules:
- Use medical context to resolve ambiguous characters: '1' vs 'l', '0' vs 'O', 'm' vs 'rn', 'cl' vs 'd'.
- Do NOT skip partially legible entries — make your best medical interpretation and include them.
- Indian prescription shorthand: T. = Tablet, Cap. = Capsule, Inj. = Injection, Syr. = Syrup, OD = once daily, BD = twice daily, TDS = three times daily, HS = at bedtime, SOS = as needed.

Return ONLY a valid JSON object. No markdown fences, no explanation, nothing outside the JSON:
{
  "doc_type": "prescription|lab_report|discharge_summary|diagnostic_report|unknown",
  "medications": [
    {
      "name": "brand or generic name as written",
      "generic": "generic name if known, else null",
      "dose": "e.g. 500mg or null",
      "frequency": "OD|BD|TDS|QID|HS|SOS|Weekly or null",
      "duration": "e.g. 5 Days or null",
      "route": "oral|IV|topical|inhaled or null",
      "instructions": "e.g. after food or null"
    }
  ],
  "lab_values": [
    {
      "test": "test name",
      "value": 7.2,
      "unit": "unit string",
      "reference_range": "as printed or null",
      "is_abnormal": true
    }
  ],
  "investigations_ordered": [],
  "diagnosis": "diagnosis text or null",
  "doctor_name": "name or null",
  "lab_name": "lab or hospital name or null",
  "report_date": "date string if visible or null",
  "clinical_notes": "any other clinically relevant text not captured above or null"
}"""


def parse_llm_json(raw: str) -> Optional[dict]:
    """Strip markdown fences if present and parse the JSON object."""
    raw = raw.strip()
    if raw.startswith("```"):
        parts = raw.split("```", 2)
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip().rstrip("`").strip()
    return json.loads(raw)
