"""
STT Test Lab — multi-engine benchmark server.

A self-contained FastAPI app for comparing speech-to-text engines on the same
recording: local faster-whisper (medium.en / large-v3 on the GPU) vs cloud
providers (Gemini, OpenAI Whisper, Deepgram). Serves a mic test page at "/"
with an engine dropdown, and transcribes uploads at "POST /transcribe".

This is an isolated test harness. It does NOT touch the main OPD app.

Run:
    pip install -r requirements.txt
    uvicorn stt_server:app --port 5005
    # then open http://localhost:5005/
"""
import os
import sys
import glob
import site
import tempfile
from pathlib import Path


def _add_nvidia_dll_dirs():
    """
    On Windows, CUDA libraries installed via the `nvidia-cublas-cu12` /
    `nvidia-cudnn-cu12` pip packages land in site-packages\\nvidia\\*\\bin but
    are NOT on the DLL search path, so CTranslate2 (faster-whisper's backend)
    fails with "cublas64_12.dll is not found". Register those folders explicitly
    before faster-whisper is imported. No-op on non-Windows / if not installed.
    """
    if sys.platform != "win32":
        return
    roots = []
    try:
        roots.extend(site.getsitepackages())
    except Exception:
        pass
    roots.append(os.path.join(sys.prefix, "Lib", "site-packages"))
    seen = set()
    for root in roots:
        for d in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            if os.path.isdir(d) and d not in seen:
                seen.add(d)
                try:
                    os.add_dll_directory(d)
                    print(f"[stt-lab] Registered CUDA DLL dir: {d}", flush=True)
                except Exception as e:
                    print(f"[stt-lab] Could not register {d}: {e}", flush=True)


_add_nvidia_dll_dirs()

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from typing import Optional

import engines

HERE = Path(__file__).parent

app = FastAPI(title="STT Test Lab")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
def index():
    return (HERE / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/engines")
def list_engines():
    """Engines for the UI dropdown, flagging which cloud keys are configured."""
    return {"engines": engines.available_engines()}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    engine: str = Form(default="local:medium.en"),
    session_id: Optional[str] = Form(default=None),
):
    """Transcribe an uploaded audio clip with the chosen engine. Audio is held
    only in memory / a temp file that is deleted right after (zero retention)."""
    contents = await file.read()
    filename = file.filename or "recording.webm"
    mime = file.content_type or "audio/webm"
    suffix = Path(filename).suffix or ".webm"

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(contents)
            tmp_path = tmp.name

        text, detail, ms = engines.transcribe(
            engine=engine,
            audio_bytes=contents,
            audio_path=tmp_path,
            filename=filename,
            mime=mime,
        )
        return {"transcript": text, "engine": engine, "detail": detail, "ms": ms}
    except Exception as e:
        print(f"[stt-lab] Transcription error [{engine}]: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5005")))
