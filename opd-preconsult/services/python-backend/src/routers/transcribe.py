"""
Bhashini two-stage transcription for the live app.

  Stage 1 — Bhashini ASR (hosted). NOT surfaced to the UI on its own.
  Stage 2 — medical-domain correction (lexicon + LLM validation + confidence),
            Hindi & Telugu only.

POST /api/transcribe   multipart: file, lang, patient_name?, session_id?,
                       question_id?, duration_ms?  → corrected text (+ meta).
                       Also stores the clip (answer_audio) so it's looped in for
                       doctor playback — same store the standalone audio used.
GET  /api/transcribe/health → { bhashini, llm } for the Stage-2 "offline" hint.
"""
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException

from ..db import execute
from .. import storage
from ..bhashini import asr, medcorrect

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

STAGE2_LANGS = ("hi", "te")
LANG_NAME = {"hi": "Hindi", "te": "Telugu", "en": "English"}


def _translate_en(text: str, lang: str):
    """Translate the (corrected) local-language transcript to English so the
    patient can see BOTH. Returns None if unavailable — never blocks."""
    if not text.strip() or lang not in STAGE2_LANGS:
        return None
    try:
        from .. import llm_client
        if not llm_client.has_llm():
            return None
        sys = (f"You are a medical translator. Translate the {LANG_NAME.get(lang, lang)} "
               "clinical statement to natural English. Return ONLY the English translation — "
               "no quotes, no notes, no transliteration.")
        out = llm_client.complete(sys, text, max_tokens=256)
        return (out or "").strip() or None
    except Exception as e:
        print(f"[transcribe] translate failed: {type(e).__name__}: {e}", flush=True)
        return None


@router.get("/health")
async def health():
    """Lets the UI show a hint when the Stage-2 medical-correction LLM is down."""
    llm_up = False
    try:
        from ..bhashini import _llm
        llm_up = _llm.have_llm()
    except Exception:
        llm_up = False
    return {"bhashini": asr.have_keys(), "llm": llm_up}


@router.post("")
async def transcribe(
    file: UploadFile = File(...),
    lang: str = Form(default="hi"),
    patient_name: str = Form(default=""),
    session_id: Optional[str] = Form(default=None),
    question_id: Optional[str] = Form(default=None),
    duration_ms: Optional[int] = Form(default=None),
):
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty audio")

    # ── Stage 1: Bhashini ASR (raw is used internally, not shown to the UI) ──
    raw, bhashini_ok = "", False
    if asr.have_keys():
        try:
            raw, _service_id, _ms1 = asr.transcribe(contents, lang)
            bhashini_ok = True
        except Exception as e:
            print(f"[transcribe] Bhashini ASR failed: {type(e).__name__}: {e}", flush=True)

    # ── Stage 2: medical correction ──
    #   hi/te → full (lexicon + de-stutter + name + LLM validation + confidence)
    #   en    → light (drug/lab-name lexicon + patient-name match only; no LLM)
    text = raw
    confidence = None
    llm_ok = False   # Stage-2 LLM was reachable (drives the "offline" hint, hi/te only)
    changes, uncertain = [], []
    # The LLM-offline hint applies only where the LLM stage actually runs (hi/te).
    stage2_attempted = bool(raw.strip()) and lang in STAGE2_LANGS
    if raw.strip():
        try:
            if lang in STAGE2_LANGS:
                c = medcorrect.correct(raw, lang, patient_name=patient_name)
                confidence = c.get("confidence")
                llm_ok = bool(c.get("llm_ok"))
                uncertain = c.get("uncertain") or []
            else:
                c = medcorrect.correct_light(raw, lang, patient_name=patient_name)
            text = c.get("corrected") or raw
            changes = c.get("changes") or []
        except Exception as e:
            print(f"[transcribe] Stage-2 correction failed: {type(e).__name__}: {e}", flush=True)

    # ── English view so the patient sees BOTH local + English ──
    text_en = _translate_en(text, lang) if text.strip() else None

    # ── Loop the clip into storage as WAV (so the doctor can play it back) ──
    if session_id and contents:
        try:
            store_bytes, mime, ext = contents, (file.content_type or "audio/webm"), "webm"
            try:
                store_bytes = asr.to_wav_bytes(contents)   # standard, universally playable
                mime, ext = "audio/wav", "wav"
            except Exception:
                pass  # keep the original container if transcode fails
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
        "text": text,                      # corrected transcript in the spoken language
        "text_en": text_en,                # English view (None if unavailable / already English)
        "lang": lang,
        "confidence": confidence,
        "llm_used": llm_ok,                # Stage-2 LLM was reachable/ran
        "stage2_attempted": stage2_attempted,
        "bhashini_ok": bhashini_ok,        # Stage-1 produced a transcript
        "changes": changes,
        "uncertain": uncertain,
    }
