"""
Text-to-Speech endpoint for the patient app's "Listen" buttons (read-aloud for
low-literacy / elderly users). Uses Bhashini TTS (on-shore, natural Indian-language
voices). Returns WAV audio; the frontend falls back to browser speech synthesis
if this is unavailable.

POST /api/tts   { text, lang }  ->  audio/wav
GET  /api/tts/health            ->  { bhashini }
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..bhashini import tts as tts_engine

router = APIRouter(prefix="/api/tts", tags=["tts"])

SUPPORTED = ("en", "hi", "te")
MAX_CHARS = 1000  # cap to keep synthesis fast and prevent abuse


class TTSRequest(BaseModel):
    text: str
    lang: str = "en"


@router.get("/health")
async def health():
    return {"bhashini": tts_engine.have_keys()}


@router.post("")
async def synthesize(req: TTSRequest):
    text = (req.text or "").strip()[:MAX_CHARS]
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if req.lang not in SUPPORTED:
        raise HTTPException(status_code=400, detail=f"Unsupported language: {req.lang}")
    if not tts_engine.have_keys():
        raise HTTPException(status_code=503, detail="Bhashini TTS not configured")
    try:
        audio = tts_engine.synthesize(text, req.lang)
    except Exception as e:
        print(f"[tts] synthesis failed: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=502, detail="TTS unavailable")
    return Response(content=audio, media_type="audio/wav")
