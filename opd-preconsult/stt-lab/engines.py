"""
STT engine registry for the test lab.

Dispatches a transcription request to one of several engines so they can be
benchmarked side by side on the same recording:

  local:medium.en   - faster-whisper medium.en on GPU (CPU fallback)
  local:large-v3    - faster-whisper large-v3 on GPU (CPU fallback)
  cloud:gemini      - Google Gemini audio (gemini-2.5-flash)
  cloud:openai      - OpenAI Whisper API (whisper-1)
  cloud:deepgram    - Deepgram nova-2

Local models are lazy-loaded and cached resident (both fit on an 8GB GPU).
Cloud engines read their keys from the main project ../.env (reusing the
existing OPENAI_API_KEY / GEMINI_API_KEY) plus a DEEPGRAM_API_KEY.
"""
import io
import os
import time
from pathlib import Path

# Load keys from the main project .env (one level up), with an optional local
# stt-lab/.env override. python-dotenv is a no-op if the file is missing.
try:
    from dotenv import load_dotenv
    _HERE = Path(__file__).parent
    load_dotenv(_HERE.parent / ".env")        # opd-preconsult/.env
    load_dotenv(_HERE / ".env", override=True)  # stt-lab/.env (optional override)
except Exception:
    pass


# ── Local engines (faster-whisper) ──────────────────────────────────────────

# name -> (WhisperModel, device_str). Cached so each model loads once.
_local_cache: dict = {}

# Local model names exposed in the UI dropdown.
LOCAL_MODELS = ["medium.en", "large-v3"]


def _get_local_model(name: str):
    """Lazy-load and cache a faster-whisper model, GPU first then CPU fallback."""
    if name in _local_cache:
        return _local_cache[name]

    from faster_whisper import WhisperModel
    try:
        model = WhisperModel(name, device="cuda", compute_type="float16")
        device = "cuda"
        print(f"[stt-lab] Loaded local model={name} on device=cuda (float16)", flush=True)
    except Exception as e:
        print(f"[stt-lab] CUDA load failed for {name} ({type(e).__name__}: {e}) — CPU fallback.", flush=True)
        model = WhisperModel(name, device="cpu", compute_type="int8")
        device = "cpu"
        print(f"[stt-lab] Loaded local model={name} on device=cpu (int8)", flush=True)

    _local_cache[name] = (model, device)
    return _local_cache[name]


def transcribe_local(name: str, audio_path: str):
    """Transcribe a file with a local faster-whisper model. Returns (text, detail)."""
    model, device = _get_local_model(name)
    segments, _info = model.transcribe(audio_path, language="en", beam_size=5)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text, f"{device} float16" if device == "cuda" else f"{device} int8"


# ── Audio helper ─────────────────────────────────────────────────────────────

def to_wav_bytes(src_bytes: bytes) -> bytes:
    """
    Transcode arbitrary audio (e.g. browser webm/opus) to 16kHz mono WAV using
    PyAV (bundled with faster-whisper — no system ffmpeg needed). Gemini does not
    accept webm, so we normalise to wav for it.
    """
    import av

    in_buf = io.BytesIO(src_bytes)
    out_buf = io.BytesIO()

    in_container = av.open(in_buf)
    out_container = av.open(out_buf, mode="w", format="wav")
    out_stream = out_container.add_stream("pcm_s16le", rate=16000)
    out_stream.layout = "mono"

    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    in_stream = in_container.streams.audio[0]

    for frame in in_container.decode(in_stream):
        for rframe in resampler.resample(frame):
            for packet in out_stream.encode(rframe):
                out_container.mux(packet)
    # flush
    for packet in out_stream.encode(None):
        out_container.mux(packet)

    out_container.close()
    in_container.close()
    return out_buf.getvalue()


# ── Cloud engines ────────────────────────────────────────────────────────────

def transcribe_gemini(audio_bytes: bytes):
    """Transcribe via Google Gemini audio. Returns (text, detail)."""
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY not set")

    from google import genai
    from google.genai import types

    wav = to_wav_bytes(audio_bytes)
    client = genai.Client(api_key=key)
    model = "gemini-2.5-flash"
    resp = client.models.generate_content(
        model=model,
        contents=[
            types.Part.from_bytes(data=wav, mime_type="audio/wav"),
            types.Part.from_text(
                text="Transcribe this audio verbatim in English. "
                     "Output only the transcript text, nothing else."
            ),
        ],
    )
    return (resp.text or "").strip(), model


def transcribe_openai(audio_bytes: bytes, filename: str):
    """Transcribe via OpenAI Whisper API. Returns (text, detail)."""
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY not set")

    from openai import OpenAI

    client = OpenAI(api_key=key)
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = filename or "recording.webm"
    result = client.audio.transcriptions.create(
        model="whisper-1",
        file=audio_file,
        language="en",
    )
    return (result.text or "").strip(), "whisper-1"


def transcribe_deepgram(audio_bytes: bytes, mime: str):
    """Transcribe via Deepgram nova-2. Returns (text, detail)."""
    key = os.getenv("DEEPGRAM_API_KEY", "").strip()
    if not key:
        raise RuntimeError("DEEPGRAM_API_KEY not set")

    import httpx

    url = "https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true&punctuate=true"
    headers = {"Authorization": f"Token {key}", "Content-Type": mime or "audio/webm"}
    with httpx.Client(timeout=120) as client:
        r = client.post(url, headers=headers, content=audio_bytes)
        r.raise_for_status()
        data = r.json()
    text = data["results"]["channels"][0]["alternatives"][0]["transcript"]
    return text.strip(), "nova-2"


# ── Registry / dispatch ──────────────────────────────────────────────────────

def available_engines():
    """List engines for the UI dropdown.

    Active set: local medium.en, local large-v3, and cloud Gemini.
    OpenAI Whisper and Deepgram are hidden after testing — surface them again
    with STT_SHOW_OPENAI=1 or STT_SHOW_DEEPGRAM=1.
    """
    has_gemini = bool(os.getenv("GEMINI_API_KEY", "").strip())
    has_openai = bool(os.getenv("OPENAI_API_KEY", "").strip())
    has_deepgram = bool(os.getenv("DEEPGRAM_API_KEY", "").strip())
    show_openai = os.getenv("STT_SHOW_OPENAI", "").strip() == "1"
    show_deepgram = os.getenv("STT_SHOW_DEEPGRAM", "").strip() == "1"

    engines = []
    for m in LOCAL_MODELS:
        engines.append({"id": f"local:{m}", "label": f"Local — {m} (GPU)", "available": True})
    engines.append({"id": "cloud:gemini", "label": "Cloud — Gemini", "available": has_gemini})
    if show_openai:
        engines.append({"id": "cloud:openai", "label": "Cloud — OpenAI Whisper", "available": has_openai})
    if show_deepgram:
        engines.append({"id": "cloud:deepgram", "label": "Cloud — Deepgram", "available": has_deepgram})
    return engines


def transcribe(engine: str, audio_bytes: bytes, audio_path: str, filename: str, mime: str):
    """
    Dispatch to the chosen engine. Returns (text, detail, ms).
    `audio_path` is a temp file (used by local); cloud engines use `audio_bytes`.
    """
    t0 = time.perf_counter()

    if engine.startswith("local:"):
        name = engine.split(":", 1)[1]
        text, detail = transcribe_local(name, audio_path)
    elif engine == "cloud:gemini":
        text, detail = transcribe_gemini(audio_bytes)
    elif engine == "cloud:openai":
        text, detail = transcribe_openai(audio_bytes, filename)
    elif engine == "cloud:deepgram":
        text, detail = transcribe_deepgram(audio_bytes, mime)
    else:
        raise ValueError(f"Unknown engine: {engine}")

    ms = int((time.perf_counter() - t0) * 1000)
    return text, detail, ms
