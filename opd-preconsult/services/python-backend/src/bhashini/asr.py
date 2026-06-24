"""
Bhashini ASR client for the test lab.

Two-step Bhashini flow:
1. Pipeline CONFIG (ULCA) -> discover the live ASR serviceId for a language.
2. Pipeline INFERENCE (Dhruva) -> send base64 WAV audio, get the transcript.

Keys come from bhashini-lab/.env (falls back to ../.env). Never hard-coded.
"""
import io
import os
import time
import base64
from pathlib import Path

try:
    from dotenv import load_dotenv
    _HERE = Path(__file__).parent
    load_dotenv(_HERE / ".env")
    load_dotenv(_HERE.parent / ".env")  # fallback, does not override
except Exception:
    pass

UDYAT_KEY = os.getenv("BHASHINI_UDYAT_KEY", "").strip()
INFERENCE_API_KEY = os.getenv("BHASHINI_INFERENCE_API_KEY", "").strip()

CONFIG_URL = "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline"
INFERENCE_URL = "https://dhruva-api.bhashini.gov.in/services/inference/pipeline"
# Public MeitY/Bhashini pipeline that exposes the ASR models.
PIPELINE_ID = os.getenv("BHASHINI_PIPELINE_ID", "64392f96daac500b55c543cd")

# Post-processing applied server-side to the raw transcript. This is the main
# accuracy/readability lever for a HOSTED ASR (there is no "beam size" knob):
#   - "itn"         inverse text normalization: spoken numbers -> digits
#                   ("twenty five" -> "25"), useful for doses/BP/dates.
#   - "punctuation" restores sentence punctuation.
# Confirmed accepted (HTTP 200) by the conformer/whisper services; unsupported
# ones are ignored gracefully. Set BHASHINI_POSTPROCESSORS="" to disable.
POSTPROCESSORS = [
    p.strip() for p in os.getenv("BHASHINI_POSTPROCESSORS", "itn,punctuation").split(",")
    if p.strip()
]

# Languages exposed in the lab (ISO-639 codes).
LANGUAGES = [
    {"code": "en", "label": "English"},
    {"code": "hi", "label": "Hindi (हिन्दी)"},
    {"code": "te", "label": "Telugu (తెలుగు)"},
]

# Fallback ASR serviceIds (used if the config call can't be reached/authorised),
# so inference still works for the evaluation. From Bhashini's available models.
# Telugu is Dravidian → served by the IITM Dravidian multilingual ASR.
FALLBACK_SERVICE_ID = {
    "en": "ai4bharat/whisper-medium-en--gpu--t4",
    "hi": "ai4bharat/conformer-hi-gpu--t4",
    "te": "bhashini/iitm/asr-dravidian--gpu--t4",
}

# Translation (NMT) — AI4Bharat IndicTrans2, the all-languages model. Used for
# the optional "Show translation" (Hindi/Telugu -> English). Same pipeline flow
# as ASR, different taskType.
FALLBACK_NMT_SERVICE_ID = "ai4bharat/indictrans-v2-all-gpu--t4"

_service_id_cache: dict = {}
_nmt_sid_cache: dict = {}


def _ssl_context():
    """Verify TLS against the OS certificate store so requests work behind
    corporate SSL inspection / antivirus that injects its own root CA (which the
    OS trusts but certifi does not). Falls back to httpx's default verification.
    This keeps verification ON — it does not disable TLS checks."""
    try:
        import ssl
        import truststore
        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:
        return True


_SSL = _ssl_context()


def have_keys() -> bool:
    return bool(INFERENCE_API_KEY)


# ── Audio: webm/opus -> 16kHz mono WAV (Bhashini expects WAV) ────────────────
# The browser already captures mono @ 16 kHz with echo-cancel, noise-suppress and
# auto-gain on, so we just transcode straight to WAV. (An earlier server-side
# loudness-normalise step was removed: stacked on top of the browser's AGC it
# over-amplified and clipped the audio, which made Bhashini return empty.)

def to_wav_bytes(src_bytes: bytes) -> bytes:
    import av

    in_buf = io.BytesIO(src_bytes)
    out_buf = io.BytesIO()
    in_container = av.open(in_buf)
    out_container = av.open(out_buf, mode="w", format="wav")
    out_stream = out_container.add_stream("pcm_s16le", rate=16000)
    out_stream.layout = "mono"
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)

    for frame in in_container.decode(in_container.streams.audio[0]):
        for rframe in resampler.resample(frame):
            for packet in out_stream.encode(rframe):
                out_container.mux(packet)
    for packet in out_stream.encode(None):
        out_container.mux(packet)
    out_container.close()
    in_container.close()
    return out_buf.getvalue()


# ── Step 1: pipeline config -> serviceId for a language ──────────────────────

def get_service_id(lang: str) -> str:
    """Discover the ASR serviceId for `lang` via the config call; cache it.
    Falls back to a known serviceId if the config call fails."""
    if lang in _service_id_cache:
        return _service_id_cache[lang]

    import httpx

    body = {
        "pipelineTasks": [{"taskType": "asr", "config": {"language": {"sourceLanguage": lang}}}],
        "pipelineRequestConfig": {"pipelineId": PIPELINE_ID},
    }
    # Auth header for the config call — the exact mapping of the Udyat key is the
    # one empirical unknown. Try the Udyat key as Authorization (newer flow); the
    # README documents fallbacks if this 401s.
    headers = {"Authorization": UDYAT_KEY} if UDYAT_KEY else {}

    try:
        with httpx.Client(timeout=30, verify=_SSL) as client:
            r = client.post(CONFIG_URL, json=body, headers=headers)
            r.raise_for_status()
            data = r.json()
        sid = data["pipelineResponseConfig"][0]["config"][0]["serviceId"]
        _service_id_cache[lang] = sid
        return sid
    except Exception as e:
        sid = FALLBACK_SERVICE_ID.get(lang)
        print(f"[bhashini] config call failed for {lang} ({type(e).__name__}: {e}); "
              f"using fallback serviceId={sid}", flush=True)
        if not sid:
            raise
        _service_id_cache[lang] = sid
        return sid


# ── Step 2: inference -> transcript ──────────────────────────────────────────

# Inference for one language given pre-encoded base64 WAV (so a multi-language
# run transcodes the audio only once).
def _infer_b64(b64: str, lang: str) -> tuple:
    import httpx

    service_id = get_service_id(lang)
    asr_config = {
        "language": {"sourceLanguage": lang},
        "serviceId": service_id,
        "audioFormat": "wav",
        "samplingRate": 16000,
    }
    if POSTPROCESSORS:
        asr_config["postProcessors"] = POSTPROCESSORS

    body = {
        "pipelineTasks": [{"taskType": "asr", "config": asr_config}],
        "inputData": {"audio": [{"audioContent": b64}]},
    }
    headers = {"Authorization": INFERENCE_API_KEY, "Content-Type": "application/json"}

    with httpx.Client(timeout=120, verify=_SSL) as client:
        r = client.post(INFERENCE_URL, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    return data["pipelineResponse"][0]["output"][0]["source"], service_id


def transcribe(audio_bytes: bytes, lang: str):
    """Transcribe audio for `lang`. Returns (text, service_id, ms)."""
    if not INFERENCE_API_KEY:
        raise RuntimeError("BHASHINI_INFERENCE_API_KEY not set")

    t0 = time.perf_counter()
    wav = to_wav_bytes(audio_bytes)
    b64 = base64.b64encode(wav).decode("utf-8")
    text, service_id = _infer_b64(b64, lang)
    ms = int((time.perf_counter() - t0) * 1000)
    return text, service_id, ms


# ── Translation (NMT): Indic -> English ──────────────────────────────────────

def get_nmt_service_id(src: str, tgt: str) -> str:
    key = f"{src}->{tgt}"
    if key in _nmt_sid_cache:
        return _nmt_sid_cache[key]

    import httpx

    body = {
        "pipelineTasks": [{"taskType": "translation",
                           "config": {"language": {"sourceLanguage": src, "targetLanguage": tgt}}}],
        "pipelineRequestConfig": {"pipelineId": PIPELINE_ID},
    }
    headers = {"Authorization": UDYAT_KEY} if UDYAT_KEY else {}
    try:
        with httpx.Client(timeout=30, verify=_SSL) as client:
            r = client.post(CONFIG_URL, json=body, headers=headers)
            r.raise_for_status()
            data = r.json()
        sid = data["pipelineResponseConfig"][0]["config"][0]["serviceId"]
    except Exception as e:
        sid = FALLBACK_NMT_SERVICE_ID
        print(f"[bhashini] NMT config failed for {key} ({type(e).__name__}: {e}); "
              f"using fallback serviceId={sid}", flush=True)
    _nmt_sid_cache[key] = sid
    return sid


def translate(text: str, src: str, tgt: str = "en") -> str:
    """Translate `text` from `src` to `tgt` via Bhashini NMT (IndicTrans2)."""
    if not INFERENCE_API_KEY:
        raise RuntimeError("BHASHINI_INFERENCE_API_KEY not set")
    if not (text or "").strip() or src == tgt:
        return text

    import httpx

    service_id = get_nmt_service_id(src, tgt)
    body = {
        "pipelineTasks": [{"taskType": "translation",
                           "config": {"language": {"sourceLanguage": src, "targetLanguage": tgt},
                                      "serviceId": service_id}}],
        "inputData": {"input": [{"source": text}]},
    }
    headers = {"Authorization": INFERENCE_API_KEY, "Content-Type": "application/json"}

    with httpx.Client(timeout=60, verify=_SSL) as client:
        r = client.post(INFERENCE_URL, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    return data["pipelineResponse"][0]["output"][0]["target"]
