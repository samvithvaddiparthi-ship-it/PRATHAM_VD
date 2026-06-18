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
import medcorrect
import llm

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


@app.get("/llm-status")
def llm_status():
    return {"llm_available": llm.have_llm(), "provider": llm.active_provider(),
            "model": llm.model_name()}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), lang: str = Form(default="hi"),
                     correct: bool = Form(default=True), patient_name: str = Form(default="")):
    """Two-stage transcription:
       Stage 1 — Bhashini ASR (raw transcript)
       Stage 2 — medical-domain correction, validation, confidence for English,
                 Hindi and Telugu (drug/lab lexicon match, patient-name mapping
                 from credentials, de-stutter, and LLM medical-context validation).
    Audio is held in memory only."""
    contents = await file.read()
    try:
        raw, service_id, ms1 = bhashini.transcribe(contents, lang)
    except Exception as e:
        print(f"[bhashini-lab] STT error [{lang}]: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    resp = {"lang": lang, "service_id": service_id, "stage1_ms": ms1,
            "raw": raw, "corrected": raw, "confidence": None,
            "changes": [], "uncertain": [], "stage2_ms": 0,
            "llm_used": False, "corrected_applied": False}

    # Stage 2 medical correction runs for English, Hindi and Telugu. The same
    # betterment strategies apply to English: drug/lab proper-noun matching from
    # the medication list, patient-name mapping from credentials, de-stutter, and
    # LLM medical-context validation. Skip if disabled/empty.
    if correct and lang in ("en", "hi", "te") and raw.strip():
        try:
            c = medcorrect.correct(raw, lang, patient_name=patient_name)
            resp.update({k: c[k] for k in
                         ("corrected", "confidence", "changes", "uncertain",
                          "stage2_ms", "llm_used")})
            resp["corrected_applied"] = True
            resp["llm_provider"] = c.get("llm_provider")
            resp["llm_model"] = c.get("llm_model")
        except Exception as e:
            print(f"[bhashini-lab] correction error: {type(e).__name__}: {e}", flush=True)
    return resp


@app.get("/stats")
def stats():
    """Recurring transcription corrections (error analysis from the log)."""
    return medcorrect.stats()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5007")))
