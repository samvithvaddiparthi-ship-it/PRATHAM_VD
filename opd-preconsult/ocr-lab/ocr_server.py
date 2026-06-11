"""
OCR Test Lab — local VLM (Ollama) vs cloud Gemini, same prompt.

A self-contained FastAPI app for comparing medical-document extraction engines
on the same image. Serves an upload test page at "/" and extracts at
"POST /extract". Mirrors the structured JSON the real app's OCR produces.

This is an isolated test harness. It does NOT touch the main OPD app.

Run:
    pip install -r requirements.txt
    uvicorn ocr_server:app --port 5006
    # then open http://localhost:5006/
"""
import io
import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from typing import Optional
from PIL import Image

HERE = Path(__file__).parent

# Cap the longest image edge before extraction. VLM cost scales with image
# tokens, so a full-res phone photo is slow; 1600px keeps printed text crisp
# while cutting vision tokens (also eases VRAM pressure / CPU spill). Bump this
# up if you find accuracy drops on dense documents.
OCR_MAX_DIM = int(os.getenv("OCR_MAX_DIM", "1600"))

import engines


def _downscale(image_bytes: bytes, mime: str):
    """Downscale to OCR_MAX_DIM longest edge if larger. Returns (bytes, mime)."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = img.convert("RGB")
        longest = max(img.size)
        if longest <= OCR_MAX_DIM:
            return image_bytes, mime
        scale = OCR_MAX_DIM / longest
        img = img.resize((int(img.size[0] * scale), int(img.size[1] * scale)), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=90)
        return out.getvalue(), "image/jpeg"
    except Exception:
        return image_bytes, mime

app = FastAPI(title="OCR Test Lab")
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
    return {"engines": engines.available_engines()}


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    engine: str = Form(default="local:qwen2.5vl"),
):
    """Extract structured medical data from an uploaded document image. The image
    is held in memory only and discarded after extraction (zero retention)."""
    contents = await file.read()
    mime = file.content_type or "image/jpeg"
    contents, mime = _downscale(contents, mime)

    try:
        structured, raw, model, ms = engines.extract(engine, contents, mime)
        return {
            "structured": structured,
            "raw": raw,
            "engine": engine,
            "model": model,
            "ms": ms,
        }
    except Exception as e:
        print(f"[ocr-lab] Extraction error [{engine}]: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5006")))
