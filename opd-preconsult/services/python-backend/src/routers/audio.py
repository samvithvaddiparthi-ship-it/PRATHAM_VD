"""
Per-answer voice recordings.

Patients can answer free-text questions by voice. We keep the actual audio (in
MinIO) alongside the transcribed text so a doctor can listen back to exactly what
the patient said. Endpoints:

  POST /api/audio/answer          — store a clip (multipart) for a session+question
  GET  /api/audio/session/{id}    — list a session's clips (for the doctor report)
  GET  /api/audio/clip/{clip_id}  — stream a clip's audio bytes

When Bhashini is wired in later, it transcribes these same stored clips instead
of the browser speech engine — no change to capture or playback.
"""
import io
from typing import Optional
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import StreamingResponse

from ..db import query, execute
from .. import storage
from ..auth import require_auth

router = APIRouter(prefix="/api/audio", tags=["audio"])


# NOTE on auth: /answer and /session/{id} require a valid JWT. /clip/{id} is left
# open because it's consumed as an <audio src> (see api.answerAudioUrl), which
# can't send an Authorization header; it only serves bytes for an opaque clip id.
@router.post("/answer", dependencies=[Depends(require_auth)])
async def upload_answer_audio(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    question_id: Optional[str] = Form(default=None),
    duration_ms: Optional[int] = Form(default=None),
    transcript: Optional[str] = Form(default=None),
):
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


@router.get("/session/{session_id}", dependencies=[Depends(require_auth)])
async def list_session_audio(session_id: str):
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
        }
        for r in rows
    ]


@router.get("/clip/{clip_id}")
async def get_clip(clip_id: str):
    rows = query("SELECT object_key, mime FROM answer_audio WHERE id = %s", (clip_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Clip not found")
    data = storage.get_bytes(rows[0]["object_key"])
    if data is None:
        raise HTTPException(status_code=404, detail="Audio bytes missing")
    return StreamingResponse(io.BytesIO(data), media_type=rows[0]["mime"] or "audio/webm")
