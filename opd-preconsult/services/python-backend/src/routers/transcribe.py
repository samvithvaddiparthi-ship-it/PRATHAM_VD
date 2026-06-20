"""
Bhashini transcription for the patient app — mirrors the standalone lab.

  Stage 1 — Bhashini ASR (hosted). The raw output is NOT surfaced to the UI.
  Stage 2 — medical-domain correction (curated drug/lab lexicon, de-stutter,
            context-gated patient-name matching). Deterministic by default;
            the LLM validation layer is opt-in (BHASHINI_STAGE2_LLM).

The transcript is shown in the SPOKEN language only (Hindi stays Hindi, Telugu
stays Telugu) — no translation. The clip is stored as WAV for doctor playback.

POST /api/transcribe   multipart: file, lang (REQUIRED), patient_name?,
                       session_id?, question_id?, duration_ms? -> { text, ... }
GET  /api/transcribe/health -> { bhashini, llm }
"""
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException

from ..db import execute
from .. import storage
from ..bhashini import asr, medcorrect, _llm

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

STAGE2_LANGS = ("en", "hi", "te")


def _native_count(text: str, lang: str) -> int:
    """How many of a transcript's letters fall in `lang`'s native script. Each
    ASR model always emits its OWN script, so a *ratio* can't compare them — but
    the model fed the language it was actually built for produces a real,
    substantial transcript, while a model fed mismatched audio produces only a
    short garbled fragment. So the native-character COUNT is the discriminator."""
    letters = [c for c in (text or "") if c.isalpha()]
    if lang == "hi":
        return sum(1 for c in letters if 0x0900 <= ord(c) <= 0x097F)
    if lang == "te":
        return sum(1 for c in letters if 0x0C00 <= ord(c) <= 0x0C7F)
    return sum(1 for c in letters if c.isascii())  # en


# Minimum native-script characters before we trust an Indic transcription over
# English (guards against a stray word the wrong model hallucinates).
_INDIC_MIN_CHARS = 4


def _detect_lang(results: dict, prefer: str = "en") -> str:
    """Pick the SPOKEN language from the per-language ASR outputs. The Indic
    model that produced the most native-script content wins (Hindi vs Telugu);
    if neither produced a meaningful amount, it's English when the English run
    has text, else the form language `prefer`."""
    hi_c = _native_count(results.get("hi", ""), "hi")
    te_c = _native_count(results.get("te", ""), "te")
    best, best_c = ("hi", hi_c) if hi_c >= te_c else ("te", te_c)
    if best_c >= _INDIC_MIN_CHARS:
        return best
    if (results.get("en", "") or "").strip():
        return "en"
    return prefer


@router.get("/health")
async def health():
    return {"bhashini": asr.have_keys(), "llm": _llm.have_llm()}


@router.post("/translate")
async def translate(text: str = Form(...), source_lang: str = Form(...)):
    """On-demand Bhashini NMT translation of a transcript to English. Called when
    the patient taps 'Show translation'. No LLM — IndicTrans2 via Bhashini."""
    if source_lang == "en" or not text.strip():
        return {"english": text, "translated": False}
    if source_lang not in ("hi", "te"):
        raise HTTPException(status_code=400, detail=f"Unsupported source language: {source_lang}")
    try:
        english = asr.translate(text, source_lang, "en")
        return {"english": english, "translated": True}
    except Exception as e:
        print(f"[transcribe] translation failed: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=502, detail="Translation unavailable")


@router.post("")
async def transcribe(
    file: UploadFile = File(...),
    lang: str = Form(...),                 # REQUIRED — never default to a language
    patient_name: str = Form(default=""),
    session_id: Optional[str] = Form(default=None),
    question_id: Optional[str] = Form(default=None),
    duration_ms: Optional[int] = Form(default=None),
):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty audio")
    if lang not in STAGE2_LANGS:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {lang}")

    # ── Stage 1: Bhashini ASR with SPOKEN-language detection ──
    # The form language (`lang`) is only a PRIOR/tiebreak. We transcribe in all
    # three languages at once and keep the one that matches what was actually
    # spoken, so Hindi speech shows Devanagari and Telugu speech shows Telugu —
    # regardless of which language was chosen at the start of the form.
    raw, bhashini_ok, detected = "", False, lang
    if asr.have_keys():
        try:
            results = asr.transcribe_multi(contents, ("en", "hi", "te"))
            detected = _detect_lang(results, prefer=lang)
            raw = results.get(detected, "") or ""
            bhashini_ok = any((v or "").strip() for v in results.values())
        except Exception as e:
            print(f"[transcribe] Bhashini multi-ASR failed: {type(e).__name__}: {e}", flush=True)
            # Fall back to a single transcription in the form language.
            try:
                raw, _service_id, _ms1 = asr.transcribe(contents, lang)
                detected, bhashini_ok = lang, True
            except Exception as e2:
                print(f"[transcribe] fallback ASR failed: {type(e2).__name__}: {e2}", flush=True)

    # ── Stage 2: medical correction in the DETECTED language ──
    text = raw
    llm_used = False
    changes = []
    if raw.strip():
        try:
            c = medcorrect.correct(raw, detected, patient_name=patient_name)
            text = c.get("corrected") or raw
            llm_used = bool(c.get("llm_used"))
            changes = c.get("changes") or []
        except Exception as e:
            print(f"[transcribe] Stage-2 correction failed: {type(e).__name__}: {e}", flush=True)

    # ── Store the clip as WAV for doctor playback ──
    if session_id and contents:
        try:
            store_bytes, mime, ext = contents, (file.content_type or "audio/webm"), "webm"
            try:
                store_bytes = asr.to_wav_bytes(contents)
                mime, ext = "audio/wav", "wav"
            except Exception:
                pass
            key = storage.upload_document(store_bytes, f"answer_{question_id or 'q'}.{ext}", session_id, content_type=mime)
            if key:
                execute(
                    """INSERT INTO answer_audio (session_id, question_id, object_key, mime, duration_ms, transcript)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    (session_id, question_id, key, mime, duration_ms, text),
                )
        except Exception as e:
            print(f"[transcribe] clip store failed (non-fatal): {type(e).__name__}: {e}", flush=True)

    return {
        "text": text,                  # corrected transcript in the SPOKEN language
        "lang": detected,              # language actually detected from the audio
        "form_lang": lang,             # language chosen on the form (prior)
        "bhashini_ok": bhashini_ok,    # Stage-1 produced a transcript
        "llm_used": llm_used,
        "llm_enabled": _llm.have_llm(),
        "changes": changes,
    }
