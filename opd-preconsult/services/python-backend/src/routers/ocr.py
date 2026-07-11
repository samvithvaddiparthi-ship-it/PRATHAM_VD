import os
import re
import io
import json
import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import StreamingResponse
from typing import Optional
from PIL import Image, ImageFilter, ImageOps
import pytesseract

from ..db import execute, query
from .. import storage
from ..auth import require_auth, enforce_ownership
from ..ratelimit import rate_limit
from ..view_audit import record_event
from .. import media_urls
from ..llm_client import complete_with_image, has_llm, has_vision
from ..drug_data import normalize_drug_name, GENERIC_DRUGS, SORTED_GENERICS

logger = logging.getLogger(__name__)

# §8c — abuse/cost limiters. OCR can hit paid cloud vision; the image route is a
# scrape target. Both fail open if Redis is down (see ratelimit.py).
_rl_ocr = rate_limit("ocr_process", default_max=20, default_window=60)
_rl_media = rate_limit("media", default_max=240, default_window=60)

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

# ── Regex fallback data (used only when no vision LLM is available) ───────────
# Shared formulary from drug_data so the OCR fallback, the interaction engine and
# the prescribe dropdown all speak the same drug vocabulary.
KNOWN_DRUGS = SORTED_GENERICS

# Brand -> formal/generic normalization of OCR-extracted drug names. Indian
# prescriptions are written in brand names (Crocin, Augmentin, Pan-D…); this maps
# them to their formal generic so the report, prescribe tab, QR slip and the
# interaction checks all use the real drug. Toggle off instantly (revert to the
# old behaviour) with OCR_NORMALIZE_BRANDS=false + restart — see _apply_generic_names.
OCR_NORMALIZE_BRANDS = os.getenv("OCR_NORMALIZE_BRANDS", "true").strip().lower() in ("1", "true", "yes", "on")

# Upload guards — reject oversized files (memory) and decompression-bomb images.
OCR_MAX_UPLOAD_MB = int(os.getenv("OCR_MAX_UPLOAD_MB", "15"))
OCR_MAX_DIM = int(os.getenv("OCR_MAX_DIM", "12000"))  # max px per side
# How many PDF pages to read. Multi-page lab reports / discharge summaries were
# previously truncated to page 1; we now stack up to this many pages into one image.
OCR_PDF_MAX_PAGES = int(os.getenv("OCR_PDF_MAX_PAGES", "5"))


def _ocr_enabled() -> bool:
    """Read the hospital-wide OCR flag (app_settings.ocr_enabled, set from the HIS
    admin dashboard). Fail OPEN — if the row/table can't be read we allow OCR, so a
    transient DB issue never silently disables document scanning."""
    try:
        rows = query("SELECT value FROM app_settings WHERE key = 'ocr_enabled'")
        if rows:
            return str(rows[0]["value"]).strip().lower() == "true"
    except Exception as e:
        logger.warning(f"ocr_enabled read failed, defaulting to enabled: {e}")
    return True


def _apply_generic_names(meds: list) -> list:
    """Fill each medication's `generic` with the formal name from the brand map.
    NON-DESTRUCTIVE: the original brand stays in `name`; we only set `generic`
    when we confidently map to a real formulary drug. Gated by OCR_NORMALIZE_BRANDS
    so the whole feature can be turned off without code changes or data loss."""
    if not OCR_NORMALIZE_BRANDS or not meds:
        return meds
    for m in meds:
        if not isinstance(m, dict):
            continue
        original = (m.get("name") or "").strip()
        if not original:
            continue
        formal = normalize_drug_name(original)
        if formal in GENERIC_DRUGS:
            m["generic"] = formal
    return meds

DOSE_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ml|iu|units?|gm?)\b', re.IGNORECASE)

FREQ_PATTERNS = [
    (re.compile(r'\b(OD|o\.?d\.?|once\s+daily)\b', re.I), 'OD'),
    (re.compile(r'\b(BD|b\.?d\.?|BID|twice\s+daily)\b', re.I), 'BD'),
    (re.compile(r'\b(TDS|t\.?d\.?s\.?|TID|thrice\s+daily|three\s+times)\b', re.I), 'TDS'),
    (re.compile(r'\b(QID|four\s+times)\b', re.I), 'QID'),
    (re.compile(r'\b(HS|h\.?s\.?|at\s+night|bed\s*time)\b', re.I), 'HS'),
    (re.compile(r'\b(SOS|as\s+needed|prn|p\.?r\.?n\.?)\b', re.I), 'SOS'),
    (re.compile(r'\b(weekly)\b', re.I), 'Weekly'),
]

LAB_PATTERNS = {
    'PT_INR':      re.compile(r'(?:PT[/-]?INR|INR)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'HbA1c':       re.compile(r'(?:HbA1c|A1C|glycated)\s*[:\-]?\s*(\d+\.?\d*)\s*%?', re.I),
    'FBS':         re.compile(r'(?:FBS|fasting\s+(?:blood\s+)?(?:sugar|glucose))\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'creatinine':  re.compile(r'(?:creatinine|creat)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'hemoglobin':  re.compile(r'(?:hemoglobin|haemoglobin|Hb|HGB)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'WBC':         re.compile(r'(?:WBC|white\s+blood|leucocyte)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'platelet':    re.compile(r'(?:platelet|PLT)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
}

REFERENCE_RANGES = {
    'PT_INR':     (0.8, 1.2),
    'HbA1c':      (4.0, 5.6),
    'FBS':        (70, 100),
    'creatinine': (0.7, 1.3),
    'hemoglobin': (12.0, 17.5),
    'WBC':        (4.0, 11.0),
    'platelet':   (150, 400),
}

# ── Vision LLM prompt ─────────────────────────────────────────────────────────

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
  name, generic name, dose (e.g. 500mg), frequency (OD/BD/TDS/QID/HS/SOS), duration (e.g. 5 Days), route (oral/IV/topical/inhaled), instructions (before food / after food / with water).
  ALWAYS fill "generic" with the active ingredient(s) — infer it from the Indian brand whenever the brand is legible (Orofer-XT -> ferrous ascorbate + folic acid; Pan-D -> pantoprazole + domperidone; Montair-LC -> montelukast + levocetirizine; Augmentin 625 -> amoxicillin + clavulanic acid; Shelcal -> calcium + vitamin D3). Use null only when the brand is too illegible to identify the drug.
  When a handwritten brand is ambiguous, prefer the closest REAL Indian pharmaceutical brand name over a literal letter-by-letter transcription — a "brand" that is not a real product is almost certainly a misread (e.g. read "Erojex" as "Orofer", "Gulbixe" as "Gutbile").
  Do NOT list these as medications (they are NOT drugs): lab tests / investigations (CBC, LFT, RFT, KFT, X-ray, USG, ECG, Echo); dosing-schedule notations and timing abbreviations (1-0-1, 0-0-1, BBF, ABF, BD, TDS, OD, SOS, stat); IV fluids (NS, RL, DNS, normal saline, ringer lactate); and non-medicinal supportive / lifestyle advice (plain steam inhalation, salt-water or warm-water gargle, ice pack, rest, plenty of fluids, diet). NOTE: a MEDICATED gargle / mouthwash such as Betadine (povidone-iodine) or chlorhexidine IS a medication and SHOULD be included.
  Also capture: doctor name, date, diagnosis or chief complaint, and investigations ordered (CBC, ECG, Echo, X-Ray, etc.) under investigations_ordered (not under medications).

For LAB_REPORT — extract EVERY result row:
  test name, exact numeric value, unit, reference range exactly as printed, abnormal flag (true if outside the printed range).
  Also capture: lab name, report date, referring doctor name.

For DISCHARGE_SUMMARY — extract:
  primary diagnosis and all comorbidities, medications at discharge (same fields as prescription), key in-hospital investigation findings, follow-up date and instructions, any procedure or surgery performed.

For DIAGNOSTIC_REPORT — extract:
  report type (ECG/Echo/X-Ray/MRI/etc.), key findings with measurements, overall impression or conclusion.

DRUG ALLERGIES — capture only allergies the document EXPLICITLY documents (e.g. "Allergic to Penicillin", "K/C/O sulfa allergy", "H/O allergy to NSAIDs"), listed under "allergies" as a list of allergen names. NEVER infer an allergy from a drug merely being present or absent. Ignore "NKDA"/"no known drug allergies" (that is not an allergy). If none are explicitly stated, return an empty list.

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
  "allergies": ["allergen name as documented"],
  "diagnosis": "diagnosis text or null",
  "doctor_name": "name or null",
  "lab_name": "lab or hospital name or null",
  "report_date": "date string if visible or null",
  "clinical_notes": "any other clinically relevant text not captured above or null",
  "confidence": 0.0
}

For "confidence", return a number between 0.0 and 1.0 expressing how confident you are that the
extraction above is accurate and complete: 1.0 = the document was fully legible and you are certain
of every value; ~0.6-0.8 = mostly legible but a few fields were unclear or inferred; below 0.5 =
poor legibility / significant guessing. Base this on the IMAGE legibility and your certainty, NOT
on how the text was typed."""


# ── Image preprocessing ───────────────────────────────────────────────────────

def preprocess_image(image: Image.Image) -> Image.Image:
    """Enhance image contrast and resolution for Tesseract on phone-captured docs.
    Uses adaptive autocontrast (per-image) rather than a fixed 2x boost, which
    over-darkens already-bright phone photos and washes out faint print."""
    img = image.convert('L')
    img = ImageOps.autocontrast(img, cutoff=1)
    img = img.filter(ImageFilter.SHARPEN)
    w, h = img.size
    if w < 1000:
        scale = 1000 / w
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return img


def _rectify_document(image: Image.Image) -> Image.Image:
    """Detect a document's four corners in a phone photo and warp it to a flat,
    front-on rectangle — correcting perspective skew AND small rotation in one step.

    Uses OpenCV, imported lazily so a build WITHOUT the wheel still runs (the
    EXIF-orientation + autocontrast path stays the baseline). Deliberately
    conservative: only warps when a convincing quadrilateral document boundary is
    found (large, convex, not the whole frame, sane aspect). Anything less certain
    returns the image unchanged — a wrong auto-crop is worse than none. Never raises."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return image
    try:
        rgb = image.convert("RGB")
        full = np.asarray(rgb)[:, :, ::-1]           # RGB -> BGR
        H, W = full.shape[:2]
        if W < 300 or H < 300:
            return image                              # too small to bother / risky

        # Detect on a downscaled copy for speed; scale corners back to full res.
        scale = 1500.0 / max(W, H) if max(W, H) > 1500 else 1.0
        small = cv2.resize(full, (int(W * scale), int(H * scale))) if scale != 1.0 else full
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(gray, 50, 150)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        img_area = small.shape[0] * small.shape[1]
        quad = None
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
            area = cv2.contourArea(c)
            if area < 0.25 * img_area:                # smaller than this isn't the page
                break
            approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
            if len(approx) == 4 and cv2.isContourConvex(approx) and area <= 0.98 * img_area:
                quad = approx.reshape(4, 2).astype("float32")
                break
        if quad is None:
            return image                              # already flat / no clear boundary

        pts = quad / scale                            # back to full-res coordinates
        s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
        tl, br = pts[np.argmin(s)], pts[np.argmax(s)]
        tr, bl = pts[np.argmin(d)], pts[np.argmax(d)]

        def _dist(a, b):
            return float(np.hypot(a[0] - b[0], a[1] - b[1]))
        out_w = int(max(_dist(tl, tr), _dist(bl, br)))
        out_h = int(max(_dist(tl, bl), _dist(tr, br)))
        if out_w < 200 or out_h < 200:
            return image
        aspect = out_w / out_h
        if aspect > 6 or aspect < 1 / 6:              # near-degenerate → likely a false hit
            return image

        src = np.array([tl, tr, br, bl], dtype="float32")
        dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], dtype="float32")
        warped = cv2.warpPerspective(full, cv2.getPerspectiveTransform(src, dst), (out_w, out_h))
        return Image.fromarray(warped[:, :, ::-1])    # BGR -> RGB
    except Exception:
        logger.warning("document rectification failed (non-fatal); using original image", exc_info=True)
        return image


def _encode_png(image: Image.Image) -> bytes:
    """Serialise a PIL image to PNG bytes (for storage + the vision call)."""
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


def _pdf_to_image(contents: bytes):
    """Render up to OCR_PDF_MAX_PAGES pages of a PDF and stack them vertically into
    ONE image, so multi-page prescriptions / lab reports aren't truncated to page 1.
    Returns (PIL.Image RGB, total_page_count). Raises ImportError if PyMuPDF missing."""
    import fitz
    pdf = fitz.open(stream=contents, filetype="pdf")
    total = len(pdf)
    n = min(total, OCR_PDF_MAX_PAGES)
    pages = []
    for i in range(n):
        pix = pdf[i].get_pixmap(matrix=fitz.Matrix(2, 2))
        pages.append(Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB"))
    if not pages:
        raise ValueError("PDF has no pages")
    if len(pages) == 1:
        combined = pages[0]
    else:
        gap = 24
        width = max(p.width for p in pages)
        height = sum(p.height for p in pages) + gap * (len(pages) - 1)
        combined = Image.new("RGB", (width, height), "white")
        y = 0
        for p in pages:
            combined.paste(p, (0, y))
            y += p.height + gap
    # Keep within the decompression-bomb dimension guard.
    longest = max(combined.width, combined.height)
    if longest > OCR_MAX_DIM:
        s = OCR_MAX_DIM / longest
        combined = combined.resize((max(1, int(combined.width * s)), max(1, int(combined.height * s))), Image.LANCZOS)
    return combined, total


# ── Regex fallback helpers (no LLM) ──────────────────────────────────────────

def extract_medications(text: str) -> list:
    medications = []
    for line in text.split('\n'):
        line_lower = line.lower().strip()
        if not line_lower:
            continue
        for drug in KNOWN_DRUGS:
            if drug in line_lower:
                med = {'name': drug.capitalize()}
                dose_match = DOSE_PATTERN.search(line)
                if dose_match:
                    med['dose'] = dose_match.group(0).strip()
                for pattern, freq_label in FREQ_PATTERNS:
                    if pattern.search(line):
                        med['frequency'] = freq_label
                        break
                if not any(m['name'].lower() == med['name'].lower() for m in medications):
                    medications.append(med)
    return medications


def extract_lab_values(text: str) -> list:
    results = []
    for test_name, pattern in LAB_PATTERNS.items():
        match = pattern.search(text)
        if match:
            value = float(match.group(1))
            entry = {'test': test_name, 'value': value, 'raw_match': match.group(0)}
            ref = REFERENCE_RANGES.get(test_name)
            if ref:
                low, high = ref
                entry['reference_range'] = f"{low}-{high}"
                entry['is_abnormal'] = value < low or value > high
            results.append(entry)
    return results


def classify_document(text: str) -> str:
    text_lower = text.lower()
    if any(w in text_lower for w in ['prescription', 'rx', 'tab ', 'cap ', 'inj ', 'syp ']):
        return 'prescription'
    if any(w in text_lower for w in ['lab report', 'test result', 'investigation', 'pathology', 'haematology']):
        return 'lab_report'
    if any(w in text_lower for w in ['discharge', 'admitted', 'diagnosis', 'hospital stay']):
        return 'discharge_summary'
    if any(w in text_lower for w in ['ecg', 'electrocardiog', 'echocardiog', '2d echo']):
        return 'diagnostic_report'
    return 'unknown'


# ── Vision LLM extraction ─────────────────────────────────────────────────────

def _parse_llm_json(raw: str) -> Optional[dict]:
    from ..llm_json import parse_llm_json
    return parse_llm_json(raw)


def extract_with_vision(image_bytes: bytes, mime_type: str, ocr_text: str, ocr_confidence: float) -> Optional[dict]:
    """
    Send image (+ optional Tesseract hint) to the vision LLM.
    Tesseract text is only included when confidence >= 0.4 (printed docs).
    For handwriting (low confidence), the LLM reads the image directly.
    """
    try:
        if ocr_confidence >= 0.4 and ocr_text.strip():
            user_text = (
                f"OCR pre-scan of this document (may contain errors):\n\n{ocr_text}\n\n"
                "Extract all medical information from the image. "
                "Use the OCR text above as a hint only — trust the image where they disagree."
            )
        else:
            user_text = (
                "This appears to be a handwritten document. "
                "Extract all medical information directly from the image."
            )

        # gemini-2.5-flash spends output tokens on internal "thinking" before
        # writing the answer; a generous ceiling ensures the JSON isn't truncated.
        raw = complete_with_image(VISION_EXTRACTION_PROMPT, user_text, image_bytes, mime_type, max_tokens=8000)
        return _parse_llm_json(raw)

    except json.JSONDecodeError as e:
        logger.warning(f"[ocr] Vision LLM returned non-JSON: {e}")
        return None
    except Exception as e:
        logger.warning(f"[ocr] Vision extraction failed: {e}")
        return None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/process", dependencies=[Depends(_rl_ocr)])
async def process_document(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(default=None),
    lang: Optional[str] = Form(default="eng"),
    doc_label: Optional[str] = Form(default=None),
    claims: dict = Depends(require_auth),
):
    """Process an uploaded document image or PDF with AI vision + Tesseract fallback."""
    if session_id:
        enforce_ownership(claims, session_id)  # §5c — upload only to own session
    contents = await file.read()

    # Guard: reject oversized uploads before loading them into memory.
    if len(contents) > OCR_MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File too large (max {OCR_MAX_UPLOAD_MB} MB)")

    # PDF → stacked page image (all pages up to OCR_PDF_MAX_PAGES, not just page 1).
    filename = (file.filename or "").lower()
    is_pdf = filename.endswith(".pdf") or (file.content_type or "").lower() == "application/pdf"
    if is_pdf:
        try:
            image, _pages = _pdf_to_image(contents)
            img_bytes = _encode_png(image)
            # Point `contents` at the RENDERED image so the vision model receives an
            # actual image (previously it got raw PDF bytes labelled image/png and
            # silently failed to a regex-only extraction).
            contents = img_bytes
            mime_type = "image/png"
        except ImportError:
            return {
                "doc_id": None, "raw_text": "", "confidence": 0.0,
                "structured": {"doc_type": "unknown", "medications": [], "lab_values": [], "extraction_source": "error"},
                "error": "PDF support not available (PyMuPDF not installed)",
            }
    else:
        image = Image.open(io.BytesIO(contents))
        # Phone-photo robustness. Two upright steps, both feeding BOTH Tesseract and
        # the vision model; re-encode only if the pixels actually changed.
        #   1. EXIF orientation (free, PIL) — undo a sideways/upside-down capture.
        #   2. Document rectification (optional OpenCV) — deskew + perspective-crop
        #      an angled photo to a flat, front-on page. No-op without the wheel or
        #      when no confident document boundary is found.
        changed = False
        oriented = ImageOps.exif_transpose(image)
        if oriented is not None and oriented is not image:
            image = oriented
            changed = True
        rectified = _rectify_document(image)
        if rectified is not image:
            image = rectified
            changed = True
        if changed:
            contents = _encode_png(image)
            mime_type = "image/png"
        else:
            fmt = (image.format or "JPEG").upper()
            mime_type = {"JPEG": "image/jpeg", "JPG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}.get(fmt, "image/jpeg")

    # Guard: reject absurd dimensions (decompression bombs) before processing.
    if image.width > OCR_MAX_DIM or image.height > OCR_MAX_DIM:
        raise HTTPException(status_code=400, detail=f"Image dimensions too large (max {OCR_MAX_DIM}px per side)")

    # ── OCR turned off hospital-wide (HIS admin → Settings) ──────────────────────
    # Store the document as-is with NO extraction (no Tesseract, no vision LLM → no
    # API cost). The image is saved so the doctor still sees the original in the
    # Documents tab; the row stays patient_confirmed=false so the generated report
    # excludes any document-derived content (report loads confirmed docs only).
    if not _ocr_enabled():
        image_key = None
        if session_id:
            try:
                store_bytes = img_bytes if is_pdf else contents
                store_mime = "image/png" if is_pdf else mime_type
                ext = "png" if is_pdf else (mime_type.split("/")[-1] or "jpg").replace("jpeg", "jpg")
                image_key = storage.upload_document(store_bytes, f"doc.{ext}", session_id, content_type=store_mime)
            except Exception:
                logger.warning("ocr document image store failed (non-fatal)", exc_info=True)
        structured = {
            "doc_type": doc_label or "document", "medications": [], "lab_values": [], "allergies": [],
            "extraction_source": "ocr_disabled", "confidence_source": "none",
        }
        doc_id = None
        if session_id:
            rows = execute(
                """INSERT INTO session_documents (session_id, doc_type, ocr_raw, ocr_structured, ocr_confidence, patient_confirmed, image_key)
                   VALUES (%s, %s, %s, %s, %s, false, %s) RETURNING id""",
                (session_id, doc_label or "document", "", json.dumps(structured), None, image_key),
            )
            if rows:
                doc_id = str(rows[0]['id'])
        return {
            'doc_id': doc_id, 'raw_text': '', 'structured': structured,
            'confidence': None, 'confidence_source': 'none', 'ocr_disabled': True,
        }

    # Tesseract — for confidence score and printed-doc hint
    processed = preprocess_image(image)
    lang_map = {'en': 'eng', 'hi': 'eng+hin', 'te': 'eng+tel', 'eng': 'eng'}
    tess_lang = lang_map.get(lang, 'eng')

    try:
        raw_text = pytesseract.image_to_string(processed, lang=tess_lang)
    except Exception:
        raw_text = pytesseract.image_to_string(processed, lang='eng')

    try:
        data = pytesseract.image_to_data(processed, lang=tess_lang, output_type=pytesseract.Output.DICT)
        confidences = [int(c) for c in data['conf'] if int(c) > 0]
        avg_confidence = sum(confidences) / len(confidences) / 100 if confidences else 0.0
    except Exception:
        avg_confidence = 0.5

    # Vision LLM extraction (primary path)
    llm_result = None
    extraction_source = "regex_fallback"

    if has_vision():
        llm_result = extract_with_vision(contents, mime_type, raw_text, avg_confidence)
        if llm_result:
            extraction_source = "vision_llm"

    if llm_result:
        doc_type = llm_result.get("doc_type") or classify_document(raw_text)
        # Displayed confidence must reflect the AI's certainty about the
        # extraction — NOT Tesseract's character score, which is meaningless for
        # handwriting the vision model read perfectly. Use the model's
        # self-reported confidence; if it gave none, assume a solid default since
        # the AI extraction did succeed.
        try:
            display_confidence = max(0.0, min(1.0, float(llm_result.get("confidence"))))
        except (TypeError, ValueError):
            display_confidence = 0.85
        confidence_source = "ai"
        structured = {
            "doc_type": doc_type,
            "medications":            _apply_generic_names(llm_result.get("medications") or []),
            "lab_values":             llm_result.get("lab_values") or [],
            "allergies":              [str(a).strip() for a in (llm_result.get("allergies") or []) if str(a).strip()],
            "investigations_ordered": llm_result.get("investigations_ordered") or [],
            "diagnosis":              llm_result.get("diagnosis"),
            "doctor_name":            llm_result.get("doctor_name"),
            "lab_name":               llm_result.get("lab_name"),
            "report_date":            llm_result.get("report_date"),
            "clinical_notes":         llm_result.get("clinical_notes"),
            "extraction_source":      extraction_source,
            "confidence_source":      confidence_source,
        }
    else:
        # Regex fallback — no vision LLM configured. Here the Tesseract score is
        # the only signal we have, so it's appropriate to show it.
        doc_type = classify_document(raw_text)
        display_confidence = round(avg_confidence, 3)
        confidence_source = "text_scan"
        structured = {
            "doc_type":          doc_type,
            "medications":       _apply_generic_names(extract_medications(raw_text)),
            "lab_values":        extract_lab_values(raw_text),
            "allergies":         [],   # no reliable regex allergy extractor; vision LLM only
            "extraction_source": "regex_fallback",
            "confidence_source": confidence_source,
        }

    display_confidence = round(display_confidence, 3)

    # Persist to DB. Also store the uploaded image (PDFs → first-page PNG) so the
    # HIS dashboard can show the actual document the patient uploaded, not just
    # the extracted text. Non-fatal if object storage is unavailable.
    image_key = None
    if session_id:
        try:
            store_bytes = img_bytes if is_pdf else contents
            store_mime = "image/png" if is_pdf else mime_type
            ext = "png" if is_pdf else (mime_type.split("/")[-1] or "jpg").replace("jpeg", "jpg")
            image_key = storage.upload_document(store_bytes, f"doc.{ext}", session_id, content_type=store_mime)
        except Exception:
            logger.warning("ocr document image store failed (non-fatal)", exc_info=True)

    doc_id = None
    if session_id:
        rows = execute(
            """INSERT INTO session_documents (session_id, doc_type, ocr_raw, ocr_structured, ocr_confidence, patient_confirmed, image_key)
               VALUES (%s, %s, %s, %s, %s, false, %s) RETURNING id""",
            (session_id, doc_label or doc_type, raw_text.strip(), json.dumps(structured), display_confidence, image_key),
        )
        if rows:
            doc_id = str(rows[0]['id'])

    return {
        'doc_id':     doc_id,
        'raw_text':   raw_text.strip(),
        'structured': structured,
        'confidence': display_confidence,
        'confidence_source': confidence_source,
    }


@router.post("/confirm/{doc_id}")
async def confirm_document(doc_id: str, body: dict = {}, claims: dict = Depends(require_auth)):
    """Patient confirms or rejects OCR output."""
    # §5c — resolve the doc's owning session and enforce ownership by it, so a
    # patient token can't confirm/reject another session's document by its id.
    owner = query("SELECT session_id FROM session_documents WHERE id = %s", (doc_id,))
    if not owner:
        raise HTTPException(status_code=404, detail="Document not found")
    enforce_ownership(claims, str(owner[0]["session_id"]))
    confirmed = body.get('confirmed', True)
    execute("UPDATE session_documents SET patient_confirmed = %s WHERE id = %s", (confirmed, doc_id))
    return {'confirmed': confirmed}


@router.get("/documents/{session_id}")
async def get_documents(session_id: str, claims: dict = Depends(require_auth)):
    """Get all documents for a session.

    Each document that has a stored image also carries `image_url` — a
    short-lived signed URL for the (otherwise open) image route. The caller is
    authenticated here, so this list is where the capability is minted.
    """
    enforce_ownership(claims, session_id)  # §5c — no cross-session doc enumeration
    rows = query(
        "SELECT * FROM session_documents WHERE session_id = %s ORDER BY created_at",
        (session_id,),
    )
    out = []
    for r in rows:
        doc = dict(r)
        doc["image_url"] = media_urls.document_image_url(str(doc["id"])) if doc.get("image_key") else None
        out.append(doc)
    return out


@router.get("/documents/image/{doc_id}", dependencies=[Depends(_rl_media)])
async def get_document_image(doc_id: str, exp: Optional[int] = None, sig: Optional[str] = None):
    """Stream the stored image for an uploaded document.

    No JWT — an `<img src>` cannot send one. Instead the URL must carry a live
    HMAC signature minted by `GET /api/ocr/documents/{session_id}` (§5b).
    """
    media_urls.verify(media_urls.KIND_DOC, doc_id, exp, sig)
    rows = query("SELECT image_key, session_id FROM session_documents WHERE id = %s", (doc_id,))
    # §6a — audit the PHI image view (ids only; deduped per doc within the window).
    if rows:
        record_event("document_image_viewed", "signed-media",
                     session_id=str(rows[0]["session_id"]),
                     extra={"doc_id": doc_id}, dedup_key=doc_id)
    key = rows[0]["image_key"] if rows else None
    if not key:
        raise HTTPException(status_code=404, detail="No image for this document")
    data = storage.get_bytes(key)
    if data is None:
        raise HTTPException(status_code=404, detail="Image unavailable")
    media_type = "image/png" if str(key).lower().endswith(".png") else "image/jpeg"
    return StreamingResponse(io.BytesIO(data), media_type=media_type)
