"""
Per-answer voice recordings.

Patients can answer free-text questions by voice. We keep the actual audio (in
MinIO) alongside the transcribed text so a doctor can listen back to exactly what
the patient said. Endpoints:

  POST /api/audio/answer          — store a clip (multipart) for a session+question
  GET  /api/audio/session/{id}    — list a session's clips (for the doctor report)
  GET  /api/audio/clip/{clip_id}  — stream a clip's audio bytes (signed URL)

When Bhashini is wired in later, it transcribes these same stored clips instead
of the browser speech engine — no change to capture or playback.
"""
import io
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import StreamingResponse

from ..db import query, execute
from .. import storage
from .. import media_urls
from ..auth import require_auth, enforce_ownership
from ..ratelimit import rate_limit
from ..view_audit import record_event

router = APIRouter(prefix="/api/audio", tags=["audio"])

# §8c — the clip route is a public (signed) scrape target; cap per client IP.
_rl_media = rate_limit("media", default_max=240, default_window=60)


# NOTE on auth: /answer and /session/{id} require a valid JWT. /clip/{id} takes no
# JWT because it's consumed as an <audio src>, which can't send an Authorization
# header — it instead requires a short-lived HMAC signature minted by
# /session/{id} (see media_urls.py, §5b).
@router.post("/answer")
async def upload_answer_audio(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    question_id: Optional[str] = Form(default=None),
    duration_ms: Optional[int] = Form(default=None),
    transcript: Optional[str] = Form(default=None),
    claims: dict = Depends(require_auth),
):
    enforce_ownership(claims, session_id)  # §5c — patient uploads only to own session
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty audio")

    mime = file.content_type or "audio/webm"
    ext = "webm" if "webm" in mime else ("ogg" if "ogg" in mime else ("mp4" if "mp4" in mime else "bin"))
    object_key = storage.upload_document(
        contents, f"answer_{question_id or 'q'}.{ext}", session_id, content_type=mime
    )
    if not object_key:
        raise HTTPException(status_code=503, detail="Audio storage unavailable")

    rows = execute(
        """INSERT INTO answer_audio (session_id, question_id, object_key, mime, duration_ms, transcript)
           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
        (session_id, question_id, object_key, mime, duration_ms, transcript),
    )
    return {"id": str(rows[0]["id"]) if rows else None}


@router.get("/session/{session_id}")
async def list_session_audio(session_id: str, claims: dict = Depends(require_auth)):
    enforce_ownership(claims, session_id)  # §5c — no cross-session clip enumeration
    rows = query(
        """SELECT id, question_id, mime, duration_ms, transcript, created_at
             FROM answer_audio
            WHERE session_id = %s
            ORDER BY created_at ASC""",
        (session_id,),
    )
    return [
        {
            "id": str(r["id"]),
            "question_id": r["question_id"],
            "mime": r["mime"],
            "duration_ms": r["duration_ms"],
            "transcript": r["transcript"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            # Signed, short-lived playback URL — the caller is authenticated here,
            # so this list is where the capability is minted.
            "url": media_urls.audio_clip_url(str(r["id"])),
        }
        for r in rows
    ]


@router.get("/clip/{clip_id}", dependencies=[Depends(_rl_media)])
async def get_clip(clip_id: str, exp: Optional[int] = None, sig: Optional[str] = None):
    """Stream a clip's bytes. Requires a live HMAC signature from /session/{id}."""
    media_urls.verify(media_urls.KIND_CLIP, clip_id, exp, sig)
    rows = query("SELECT object_key, mime, session_id FROM answer_audio WHERE id = %s", (clip_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Clip not found")
    # §6a — audit the PHI audio playback (ids only; deduped per clip within window).
    record_event("audio_clip_accessed", "signed-media",
                 session_id=str(rows[0]["session_id"]),
                 extra={"clip_id": clip_id}, dedup_key=clip_id)
    data = storage.get_bytes(rows[0]["object_key"])
    if data is None:
        raise HTTPException(status_code=404, detail="Audio bytes missing")
    return StreamingResponse(io.BytesIO(data), media_type=rows[0]["mime"] or "audio/webm")
