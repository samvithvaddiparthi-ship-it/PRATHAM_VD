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
):
    """
    Transcribe audio using OpenAI Whisper API.
    Audio is held in memory only — zero retention after transcription.
    """
    contents = await file.read()

    try:
        import openai
        client = openai.OpenAI()

        # Create an in-memory file-like object for the API
        audio_file = io.BytesIO(contents)
        audio_file.name = file.filename or "recording.webm"

        transcription = client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language="en",
        )

        transcript_text = transcription.text
    except ImportError:
        # Fallback: return placeholder if openai package not installed
        transcript_text = "[Whisper API not configured — install openai package and set OPENAI_API_KEY]"
    except Exception as e:
        print(f"[scribe] Transcription error: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        # Zero-retention: explicitly clear audio from memory
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
