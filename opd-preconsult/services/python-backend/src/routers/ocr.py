import re
import io
import json
import logging
from fastapi import APIRouter, UploadFile, File, Form
from typing import Optional
from PIL import Image, ImageFilter, ImageEnhance
import pytesseract

from ..db import execute, query
from ..llm_client import complete_with_image, has_llm, has_vision

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

# Common Indian drug names for matching (expandable)
KNOWN_DRUGS = [
    "warfarin", "acenocoumarol", "rivaroxaban", "apixaban", "heparin",
    "metoprolol", "atenolol", "propranolol", "carvedilol", "bisoprolol",
    "amlodipine", "nifedipine", "diltiazem", "verapamil",
    "enalapril", "ramipril", "lisinopril", "telmisartan", "losartan", "olmesartan",
    "furosemide", "torsemide", "spironolactone", "hydrochlorothiazide",
    "aspirin", "clopidogrel", "ticagrelor", "prasugrel",
    "atorvastatin", "rosuvastatin", "simvastatin",
    "metformin", "glipizide", "glimepiride", "sitagliptin", "vildagliptin",
    "empagliflozin", "dapagliflozin", "canagliflozin",
    "insulin", "pioglitazone",
    "digoxin", "amiodarone", "ivabradine",
    "nitroglycerin", "isosorbide",
    "pantoprazole", "omeprazole", "rabeprazole",
    "paracetamol", "ibuprofen", "diclofenac",
    "levothyroxine", "carbimazole",
    "prednisolone", "dexamethasone", "methylprednisolone",
    "azithromycin", "amoxicillin", "ciprofloxacin", "ceftriaxone",
    "montelukast", "salbutamol", "budesonide",
]

# Dose patterns
DOSE_PATTERN = re.compile(
    r'(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ml|iu|units?|gm?)\b',
    re.IGNORECASE
)

# Frequency patterns
FREQ_PATTERNS = [
    (re.compile(r'\b(OD|o\.?d\.?|once\s+daily)\b', re.I), 'OD'),
    (re.compile(r'\b(BD|b\.?d\.?|BID|twice\s+daily)\b', re.I), 'BD'),
    (re.compile(r'\b(TDS|t\.?d\.?s\.?|TID|thrice\s+daily|three\s+times)\b', re.I), 'TDS'),
    (re.compile(r'\b(QID|four\s+times)\b', re.I), 'QID'),
    (re.compile(r'\b(HS|h\.?s\.?|at\s+night|bed\s*time)\b', re.I), 'HS'),
    (re.compile(r'\b(SOS|as\s+needed|prn|p\.?r\.?n\.?)\b', re.I), 'SOS'),
    (re.compile(r'\b(weekly)\b', re.I), 'Weekly'),
]

# Lab test patterns
LAB_PATTERNS = {
    'PT_INR': re.compile(r'(?:PT[/-]?INR|INR)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'HbA1c': re.compile(r'(?:HbA1c|A1C|glycated)\s*[:\-]?\s*(\d+\.?\d*)\s*%?', re.I),
    'FBS': re.compile(r'(?:FBS|fasting\s+(?:blood\s+)?(?:sugar|glucose))\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'creatinine': re.compile(r'(?:creatinine|creat)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'hemoglobin': re.compile(r'(?:hemoglobin|haemoglobin|Hb|HGB)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'WBC': re.compile(r'(?:WBC|white\s+blood|leucocyte)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
    'platelet': re.compile(r'(?:platelet|PLT)\s*[:\-]?\s*(\d+\.?\d*)', re.I),
}

# Normal reference ranges: (low, high) — values outside trigger is_abnormal
REFERENCE_RANGES = {
    'PT_INR': (0.8, 1.2),
    'HbA1c': (4.0, 5.6),
    'FBS': (70, 100),
    'creatinine': (0.7, 1.3),
    'hemoglobin': (12.0, 17.5),
    'WBC': (4.0, 11.0),
    'platelet': (150, 400),
}


def preprocess_image(image: Image.Image) -> Image.Image:
    """Enhance image for better OCR on phone-captured prescriptions."""
    # Convert to grayscale
    img = image.convert('L')
    # Increase contrast
    img = ImageEnhance.Contrast(img).enhance(2.0)
    # Sharpen
    img = img.filter(ImageFilter.SHARPEN)
    # Resize if too small
    w, h = img.size
    if w < 1000:
        scale = 1000 / w
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    return img


def extract_medications(text: str) -> list:
    """Extract medication names, doses, and frequencies from OCR text."""
    medications = []
    lines = text.split('\n')

    for line in lines:
        line_lower = line.lower().strip()
        if not line_lower:
            continue

        for drug in KNOWN_DRUGS:
            if drug in line_lower:
                med = {'name': drug.capitalize()}

                # Look for dose in same line
                dose_match = DOSE_PATTERN.search(line)
                if dose_match:
                    med['dose'] = dose_match.group(0).strip()

                # Look for frequency
                for pattern, freq_label in FREQ_PATTERNS:
                    if pattern.search(line):
                        med['frequency'] = freq_label
                        break

                # Avoid duplicates
                if not any(m['name'].lower() == med['name'].lower() for m in medications):
                    medications.append(med)

    return medications


def extract_lab_values(text: str) -> list:
    """Extract lab test results from OCR text with abnormal flagging."""
    results = []
    for test_name, pattern in LAB_PATTERNS.items():
        match = pattern.search(text)
        if match:
            value = float(match.group(1))
            entry = {
                'test': test_name,
                'value': value,
                'raw_match': match.group(0),
            }
            ref = REFERENCE_RANGES.get(test_name)
            if ref:
                low, high = ref
                entry['reference_range'] = f"{low}-{high}"
                entry['is_abnormal'] = value < low or value > high
            results.append(entry)
    return results


def classify_document(text: str) -> str:
    """Classify document type from OCR text."""
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


LLM_EXTRACTION_SYSTEM_PROMPT = """You are a medical document extraction assistant for Indian hospitals.
Given an image of a medical document and its OCR text, extract all structured information and return ONLY valid JSON.

Return this exact JSON structure with no extra text, no markdown, no code fences:
{
  "doc_type": "prescription|lab_report|discharge_summary|diagnostic_report|unknown",
  "medications": [
    {
      "name": "drug brand or generic name",
      "generic": "generic name if known",
      "dose": "e.g. 500mg",
      "frequency": "e.g. BD, TDS, OD",
      "duration": "e.g. 5 Days",
      "instructions": "e.g. after food"
    }
  ],
  "lab_values": [
    {
      "test": "test name",
      "value": 7.2,
      "unit": "unit string",
      "reference_range": "normal range string",
      "is_abnormal": true
    }
  ],
  "investigations_ordered": ["test1", "test2"],
  "diagnosis": "diagnosis if present",
  "doctor_name": "doctor name if present"
}

Rules:
- Extract ALL medications visible — including brand names like Augmentin, Crocin, Dolo, Pan-D, etc.
- For Indian brand names, include both brand and generic where known
- Extract all lab values with their units and flag abnormals based on standard Indian reference ranges
- Extract investigations ordered (e.g. CBC, ECG, X-Ray)
- If a field has no data, use null for strings and [] for arrays
- Return ONLY the JSON object, nothing else"""


def extract_with_gemini(image_bytes: bytes, mime_type: str, ocr_text: str) -> Optional[dict]:
    """Use Gemini Vision to extract structured data from a medical document image."""
    try:
        user_text = f"OCR text extracted from this document (may have errors):\n\n{ocr_text}\n\nPlease extract all medical information from the image above."
        raw = complete_with_image(LLM_EXTRACTION_SYSTEM_PROMPT, user_text, image_bytes, mime_type, max_tokens=1500)

        # Strip any accidental markdown code fences
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        raw = raw.strip().rstrip("`").strip()

        return json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning(f"[ocr] Gemini returned non-JSON: {e}")
        return None
    except Exception as e:
        logger.warning(f"[ocr] Gemini Vision extraction failed: {e}")
        return None


@router.post("/process")
async def process_document(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(default=None),
    lang: Optional[str] = Form(default="eng"),
    doc_label: Optional[str] = Form(default=None),
):
    """Process an uploaded document image or PDF with Tesseract OCR and store in DB."""
    contents = await file.read()

    # Handle PDF — convert first page to image
    filename = (file.filename or "").lower()
    is_pdf = filename.endswith(".pdf") or (file.content_type or "").lower() == "application/pdf"
    if is_pdf:
        try:
            import fitz  # PyMuPDF
            pdf = fitz.open(stream=contents, filetype="pdf")
            page = pdf[0]
            mat = fitz.Matrix(2, 2)  # 2x zoom for better resolution
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
            image = Image.open(io.BytesIO(img_bytes))
            mime_type = "image/png"
        except ImportError:
            # PyMuPDF not installed — return error
            return {"doc_id": None, "raw_text": "", "structured": {"doc_type": "unknown", "medications": [], "lab_values": [], "extraction_source": "error"}, "confidence": 0.0, "error": "PDF support not available"}
    else:
        image = Image.open(io.BytesIO(contents))
        fmt = (image.format or "JPEG").upper()
        mime_map = {"JPEG": "image/jpeg", "JPG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
        mime_type = mime_map.get(fmt, "image/jpeg")

    # Preprocess for Tesseract
    processed = preprocess_image(image)

    # OCR with Tesseract — use English + Hindi/Telugu based on lang param
    lang_map = {'en': 'eng', 'hi': 'eng+hin', 'te': 'eng+tel', 'eng': 'eng'}
    tess_lang = lang_map.get(lang, 'eng')

    try:
        raw_text = pytesseract.image_to_string(processed, lang=tess_lang)
    except Exception:
        raw_text = pytesseract.image_to_string(processed, lang='eng')

    # Get Tesseract confidence
    try:
        data = pytesseract.image_to_data(processed, lang=tess_lang, output_type=pytesseract.Output.DICT)
        confidences = [int(c) for c in data['conf'] if int(c) > 0]
        avg_confidence = sum(confidences) / len(confidences) / 100 if confidences else 0.0
    except Exception:
        avg_confidence = 0.5

    # --- Gemini Vision extraction (primary) ---
    llm_result = None
    extraction_source = "regex"
    if has_vision():
        llm_result = extract_with_gemini(contents, mime_type, raw_text)
        if llm_result:
            extraction_source = "gemini_vision"

    if llm_result:
        medications = llm_result.get("medications") or []
        lab_values = llm_result.get("lab_values") or []
        doc_type = llm_result.get("doc_type") or classify_document(raw_text)
        structured = {
            "doc_type": doc_type,
            "medications": medications,
            "lab_values": lab_values,
            "investigations_ordered": llm_result.get("investigations_ordered") or [],
            "diagnosis": llm_result.get("diagnosis"),
            "doctor_name": llm_result.get("doctor_name"),
            "extraction_source": extraction_source,
        }
    else:
        # --- Regex fallback ---
        medications = extract_medications(raw_text)
        lab_values = extract_lab_values(raw_text)
        doc_type = classify_document(raw_text)
        structured = {
            "doc_type": doc_type,
            "medications": medications,
            "lab_values": lab_values,
            "extraction_source": "regex_fallback",
        }

    # Store in session_documents if session_id provided
    doc_id = None
    if session_id:
        rows = execute(
            """INSERT INTO session_documents (session_id, doc_type, ocr_raw, ocr_structured, ocr_confidence, patient_confirmed)
               VALUES (%s, %s, %s, %s, %s, false) RETURNING id""",
            (session_id, doc_label or doc_type, raw_text.strip(), json.dumps(structured), round(avg_confidence, 3)),
        )
        if rows:
            doc_id = str(rows[0]['id'])

    return {
        'doc_id': doc_id,
        'raw_text': raw_text.strip(),
        'structured': structured,
        'confidence': round(avg_confidence, 3),
    }


@router.post("/confirm/{doc_id}")
async def confirm_document(doc_id: str, body: dict = {}):
    """Patient confirms or rejects OCR output."""
    confirmed = body.get('confirmed', True)
    execute(
        "UPDATE session_documents SET patient_confirmed = %s WHERE id = %s",
        (confirmed, doc_id),
    )
    return {'confirmed': confirmed}


@router.get("/documents/{session_id}")
async def get_documents(session_id: str):
    """Get all documents for a session."""
    rows = query(
        "SELECT * FROM session_documents WHERE session_id = %s ORDER BY created_at",
        (session_id,),
    )
    return rows
