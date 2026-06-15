"""
OCR engine registry for the test lab.

Dispatches a document image to one of two engines so they can be benchmarked
side by side on the same image:

  local:qwen2.5vl  - local Vision-Language Model served by Ollama (GPU)
  cloud:gemini     - Google Gemini vision (gemini-2.5-flash)

Both use the SAME extraction prompt (prompt.py) for an apples-to-apples
comparison. Cloud key is read from the main project ../.env.
"""
import os
import time
import json
import base64
from pathlib import Path

from prompt import VISION_EXTRACTION_PROMPT, parse_llm_json

# Load keys from the main project .env (one level up), with an optional local
# ocr-lab/.env override. No-op if the files are missing.
try:
    from dotenv import load_dotenv
    _HERE = Path(__file__).parent
    load_dotenv(_HERE.parent / ".env")          # opd-preconsult/.env
    load_dotenv(_HERE / ".env", override=True)   # ocr-lab/.env (optional)
except Exception:
    pass

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
# Default to 3B: fully GPU-resident on an 8GB card (fast, ~7s) and accurate on
# handwriting at 1536px. Use 7B (OCR_LOCAL_MODEL=qwen2.5vl:7b) for max accuracy
# on the hardest documents, accepting higher latency from CPU spill.
OCR_LOCAL_MODEL = os.getenv("OCR_LOCAL_MODEL", "qwen2.5vl:3b")


# ── Local engine (Ollama VLM) ────────────────────────────────────────────────

def _ollama_reachable() -> bool:
    import httpx
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def extract_local(image_bytes: bytes, mime: str):
    """Extract via a local Ollama VLM. Returns (structured_dict, raw_text)."""
    import httpx

    b64 = base64.b64encode(image_bytes).decode("utf-8")
    payload = {
        "model": OCR_LOCAL_MODEL,
        "prompt": VISION_EXTRACTION_PROMPT,
        "images": [b64],
        "stream": False,
        "format": "json",          # force valid JSON output
        "keep_alive": -1,          # keep the model resident — no reload between runs
        # num_ctx: the long extraction prompt + a 2048px image is ~4800 tokens,
        # which overflows Ollama's default 4096 context (causes HTTP 400). Give it
        # a roomy window. num_predict capped at 2048 (the JSON output is small) so
        # prompt + generation comfortably fit inside num_ctx.
        "options": {"temperature": 0.1, "num_predict": 2048, "num_ctx": int(os.getenv("OCR_NUM_CTX", "8192"))},
    }
    with httpx.Client(timeout=300) as client:
        r = client.post(f"{OLLAMA_URL}/api/generate", json=payload)
        r.raise_for_status()
        raw = r.json().get("response", "")

    try:
        structured = parse_llm_json(raw)
    except json.JSONDecodeError:
        structured = None
    return structured, raw


# ── Cloud engine (Gemini vision) ─────────────────────────────────────────────

def extract_gemini(image_bytes: bytes, mime: str):
    """Extract via Google Gemini vision. Returns (structured_dict, raw_text)."""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY not set")

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=key)
    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime),
            types.Part.from_text(
                text="Extract all medical information from this document image."
            ),
        ],
        config=types.GenerateContentConfig(
            system_instruction=VISION_EXTRACTION_PROMPT,
            max_output_tokens=8000,
            temperature=0.1,
        ),
    )
    raw = resp.text or ""
    try:
        structured = parse_llm_json(raw)
    except json.JSONDecodeError:
        structured = None
    return structured, raw


# ── Registry / dispatch ──────────────────────────────────────────────────────

def available_engines():
    """List engines for the UI dropdown, flagging availability."""
    has_gemini = bool(os.getenv("GEMINI_API_KEY", "").strip())
    ollama_up = _ollama_reachable()
    return [
        {"id": "local:qwen2.5vl", "label": f"Local — {OCR_LOCAL_MODEL} (Ollama/GPU)", "available": ollama_up},
        {"id": "cloud:gemini", "label": "Cloud — Gemini", "available": has_gemini},
    ]


def extract(engine: str, image_bytes: bytes, mime: str):
    """Dispatch to the chosen engine. Returns (structured, raw, model, ms)."""
    t0 = time.perf_counter()

    if engine == "local:qwen2.5vl":
        structured, raw = extract_local(image_bytes, mime)
        model = OCR_LOCAL_MODEL
    elif engine == "cloud:gemini":
        structured, raw = extract_gemini(image_bytes, mime)
        model = "gemini-2.5-flash"
    else:
        raise ValueError(f"Unknown engine: {engine}")

    ms = int((time.perf_counter() - t0) * 1000)
    return structured, raw, model, ms
