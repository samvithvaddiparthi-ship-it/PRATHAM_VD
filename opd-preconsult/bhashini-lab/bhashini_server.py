"""
Bhashini STT Test Lab — standalone evaluation server.

Records audio in the browser, sends it to Bhashini's ASR API, and shows the
transcript for English / Hindi / Kannada. Isolated from the main OPD app.

Run:
    pip install -r requirements.txt
    uvicorn bhashini_server:app --port 5007
    # then open http://localhost:5007/
"""
import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

import bhashini

HERE = Path(__file__).parent

app = FastAPI(title="Bhashini STT Test Lab")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/", response_class=HTMLResponse)
def index():
    return (HERE / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    return {"status": "ok", "keys_configured": bhashini.have_keys()}


@app.get("/languages")
def languages():
    return {"languages": bhashini.LANGUAGES, "keys_configured": bhashini.have_keys()}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), lang: str = Form(default="hi")):
    """Transcribe an uploaded clip via Bhashini. Audio held in memory only."""
    contents = await file.read()
    try:
        text, service_id, ms = bhashini.transcribe(contents, lang)
        return {"transcript": text, "lang": lang, "service_id": service_id, "ms": ms}
    except Exception as e:
        print(f"[bhashini-lab] error [{lang}]: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5007")))
