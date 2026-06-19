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


@router.get("/health")
async def health():
    return {"bhashini": asr.have_keys(), "llm": _llm.have_llm()}


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

    # ── Stage 1: Bhashini ASR (raw is internal, never shown) ──
    raw, bhashini_ok = "", False
    if asr.have_keys():
        try:
            raw, _service_id, _ms1 = asr.transcribe(contents, lang)
            bhashini_ok = True
        except Exception as e:
            print(f"[transcribe] Bhashini ASR failed: {type(e).__name__}: {e}", flush=True)

    # ── Stage 2: medical correction (same engine as the lab) ──
    text = raw
    llm_used = False
    changes = []
    if raw.strip():
        try:
            c = medcorrect.correct(raw, lang, patient_name=patient_name)
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
        "lang": lang,
        "bhashini_ok": bhashini_ok,    # Stage-1 produced a transcript
        "llm_used": llm_used,
        "llm_enabled": _llm.have_llm(),
        "changes": changes,
    }
