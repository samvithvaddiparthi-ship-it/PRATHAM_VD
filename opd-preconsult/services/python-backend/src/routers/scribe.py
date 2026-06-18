import io
import json
import traceback
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from typing import Optional

from ..db import execute, query

router = APIRouter(prefix="/api/scribe", tags=["scribe"])

PROMPT_DIR = Path(__file__).parent.parent / "prompts"


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(default=None),
    lang: str = Form(default="en"),
):
    """
    Transcribe the consultation audio with Bhashini (Stage 1 ASR) + medical
    correction (Stage 2). Falls back to OpenAI Whisper if Bhashini is unavailable.
    Audio is held in memory only.
    """
    contents = await file.read()
    transcript_text = ""

    # ── Primary: Bhashini (same engine as the patient transcription) ──
    from ..bhashini import asr, medcorrect
    if asr.have_keys():
        try:
            raw, _sid, _ms = asr.transcribe(contents, lang)
            transcript_text = raw or ""
            if transcript_text.strip():
                try:
                    transcript_text = medcorrect.correct(transcript_text, lang).get("corrected") or transcript_text
                except Exception as e:
                    print(f"[scribe] Stage-2 correction failed: {type(e).__name__}: {e}", flush=True)
        except Exception as e:
            print(f"[scribe] Bhashini ASR failed: {type(e).__name__}: {e}", flush=True)

    # ── Fallback: OpenAI Whisper ──
    if not transcript_text.strip():
        try:
            import openai
            client = openai.OpenAI()
            audio_file = io.BytesIO(contents)
            audio_file.name = file.filename or "recording.webm"
            transcription = client.audio.transcriptions.create(
                model="whisper-1", file=audio_file, language=lang if lang in ("en", "hi") else "en",
            )
            transcript_text = transcription.text
        except ImportError:
            transcript_text = "[Transcription unavailable — Bhashini keys missing and Whisper not configured]"
        except Exception as e:
            print(f"[scribe] Whisper fallback error: {type(e).__name__}: {e}", flush=True)
            if not transcript_text:
                raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    contents = None

    return {
        "transcript": transcript_text,
        "session_id": session_id,
    }


@router.post("/extract-soap")
async def extract_soap(body: dict):
    """
    Extract SOAP notes from a consultation transcript using LLM.
    """
    transcript = body.get("transcript", "")
    session_id = body.get("session_id")

    if not transcript:
        raise HTTPException(status_code=400, detail="transcript required")

    try:
        system_prompt = (PROMPT_DIR / "system_scribe.txt").read_text()
    except FileNotFoundError:
        system_prompt = "Extract clinical SOAP notes from this doctor-patient conversation transcript. Output as JSON."

    # Use the existing LLM client
    from ..llm_client import has_llm, complete as llm_complete

    soap_json = None
    if has_llm():
        try:
            result = llm_complete(system_prompt, transcript, max_tokens=2048)
            # Try to parse as JSON
            try:
                # Find JSON in the response
                json_start = result.find('{')
                json_end = result.rfind('}') + 1
                if json_start >= 0 and json_end > json_start:
                    soap_json = json.loads(result[json_start:json_end])
            except json.JSONDecodeError:
                soap_json = {"raw_response": result}
        except Exception as e:
            print(f"[scribe] LLM extraction error: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()

    if not soap_json:
        soap_json = _fallback_soap(transcript)

    # Store in DB if session_id provided
    if session_id:
        try:
            execute(
                """UPDATE session_reports SET scribe_transcript = %s, scribe_soap = %s, scribe_created_at = NOW()
                   WHERE session_id = %s""",
                (transcript, json.dumps(soap_json), session_id),
            )
        except Exception as e:
            print(f"[scribe] DB store error: {e}", flush=True)

    return {
        "soap": soap_json,
        "session_id": session_id,
    }


@router.post("/soap/{session_id}")
async def save_soap(session_id: str, body: dict):
    """Persist the doctor's edited SOAP note (free text). Stored in the existing
    scribe_soap column as {"text": ...} so it round-trips through get_soap."""
    soap_text = (body.get("soap_text") or "").strip()
    try:
        execute(
            """UPDATE session_reports SET scribe_soap = %s, scribe_created_at = NOW()
               WHERE session_id = %s""",
            (json.dumps({"text": soap_text}), session_id),
        )
    except Exception as e:
        print(f"[scribe] save_soap error: {e}", flush=True)
        raise HTTPException(status_code=500, detail="Could not save SOAP note")
    return {"saved": True}


@router.get("/soap/{session_id}")
async def get_soap(session_id: str):
    """Retrieve stored SOAP notes for a session."""
    rows = query(
        "SELECT scribe_transcript, scribe_soap, scribe_created_at FROM session_reports WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    )
    if not rows or not rows[0].get("scribe_soap"):
        raise HTTPException(status_code=404, detail="No scribe notes found")
    r = rows[0]
    return {
        "transcript": r["scribe_transcript"],
        "soap": r["scribe_soap"],
        "created_at": str(r["scribe_created_at"]) if r["scribe_created_at"] else None,
    }


def _fallback_soap(transcript):
    """Basic keyword-based SOAP extraction when LLM is unavailable."""
    lines = transcript.strip().split('\n')
    return {
        "subjective": {
            "chief_complaint": "See transcript",
            "history_of_present_illness": transcript[:500] if transcript else "Not available",
        },
        "objective": {"notes": "Extracted without LLM — review transcript for details"},
        "assessment": {"notes": "Pending physician review"},
        "plan": {"notes": "Pending physician review"},
        "_note": "LLM unavailable — raw transcript preserved for manual review",
    }
