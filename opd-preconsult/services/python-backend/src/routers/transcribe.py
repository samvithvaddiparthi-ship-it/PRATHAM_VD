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
import logging
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends

from ..db import execute
from .. import storage
from ..auth import require_auth, enforce_ownership
from ..bhashini import asr, medcorrect, _llm

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

STAGE2_LANGS = ("en", "hi", "te")


@router.get("/health")
async def health():
    return {"bhashini": asr.have_keys(), "llm": _llm.have_llm()}


@router.post("/translate", dependencies=[Depends(require_auth)])
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
    except Exception:
        logger.warning("transcribe translation failed", exc_info=True)
        raise HTTPException(status_code=502, detail="Translation unavailable")


@router.post("")
async def transcribe(
    file: UploadFile = File(...),
    lang: str = Form(...),                 # REQUIRED — never default to a language
    patient_name: str = Form(default=""),
    session_id: Optional[str] = Form(default=None),
    question_id: Optional[str] = Form(default=None),
    duration_ms: Optional[int] = Form(default=None),
    claims: dict = Depends(require_auth),
):
    if session_id:
        enforce_ownership(claims, session_id)  # §5c — store only to own session
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty audio")
    if lang not in STAGE2_LANGS:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {lang}")

    # ── Stage 1: Bhashini ASR in the CHOSEN language ──
    # `lang` is the language the patient explicitly chose to speak in (picked
    # once on the first voice question, applied to every mic after). No
    # detection — the chosen language is authoritative, so there are no
    # detection errors and Hindi/Telugu/English each transcribe cleanly.
    raw, bhashini_ok = "", False
    if asr.have_keys():
        try:
            raw, _service_id, _ms1 = asr.transcribe(contents, lang)
            bhashini_ok = True
        except Exception:
            logger.warning("transcribe Bhashini ASR failed", exc_info=True)

    # ── Stage 2: medical correction in the chosen language ──
    text = raw
    llm_used = False
    changes = []
    if raw.strip():
        try:
            c = medcorrect.correct(raw, lang, patient_name=patient_name)
            text = c.get("corrected") or raw
            llm_used = bool(c.get("llm_used"))
            changes = c.get("changes") or []
        except Exception:
            logger.warning("transcribe Stage-2 correction failed", exc_info=True)

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
        except Exception:
            logger.warning("transcribe clip store failed (non-fatal)", exc_info=True)

    return {
        "text": text,                  # corrected transcript in the chosen language
        "lang": lang,                  # the language the patient chose to speak in
        "bhashini_ok": bhashini_ok,    # Stage-1 produced a transcript
        "llm_used": llm_used,
        "llm_enabled": _llm.have_llm(),
        "changes": changes,
    }
