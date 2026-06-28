"""
Bhashini Text-to-Speech (TTS) — additive, mirrors the ASR/NMT flow in asr.py.

Two-step Bhashini flow (same as ASR):
1. Pipeline CONFIG (ULCA) -> discover the live TTS serviceId for a language.
2. Pipeline INFERENCE (Dhruva) -> send text, get base64 WAV audio back.

Reuses the keys, URLs and TLS context from asr.py so it doesn't duplicate config
or touch the existing speech-to-text / translation code (Samvith's area).
"""
import base64

from .asr import (
    UDYAT_KEY, INFERENCE_API_KEY, CONFIG_URL, INFERENCE_URL, PIPELINE_ID,
    _SSL, have_keys,  # noqa: F401  (have_keys re-exported for the router)
)

# Fallback TTS serviceIds (used if the config call can't be reached/authorised).
# AI4Bharat IndicTTS (Coqui), grouped by language family on Bhashini.
FALLBACK_TTS_SERVICE_ID = {
    "en": "ai4bharat/indic-tts-coqui-misc-gpu--t4",
    "hi": "ai4bharat/indic-tts-coqui-indo_aryan-gpu--t4",
    "te": "ai4bharat/indic-tts-coqui-dravidian-gpu--t4",
}

_tts_sid_cache: dict = {}


def get_tts_service_id(lang: str) -> str:
    """Resolve the TTS serviceId for `lang`. The known-good fallback IDs (verified
    working) are used by default; config discovery is only attempted when a ULCA
    Udyat key is configured. Without a key the discovery call is unreliable and can
    return a serviceId that 500s on inference, so we skip it."""
    if lang in _tts_sid_cache:
        return _tts_sid_cache[lang]

    sid = FALLBACK_TTS_SERVICE_ID.get(lang)

    if UDYAT_KEY:
        import httpx
        body = {
            "pipelineTasks": [{"taskType": "tts", "config": {"language": {"sourceLanguage": lang}}}],
            "pipelineRequestConfig": {"pipelineId": PIPELINE_ID},
        }
        try:
            with httpx.Client(timeout=30, verify=_SSL) as client:
                r = client.post(CONFIG_URL, json=body, headers={"Authorization": UDYAT_KEY})
                r.raise_for_status()
                data = r.json()
            sid = data["pipelineResponseConfig"][0]["config"][0]["serviceId"]
        except Exception as e:
            print(f"[bhashini] TTS config failed for {lang} ({type(e).__name__}: {e}); "
                  f"using fallback serviceId={sid}", flush=True)

    if not sid:
        raise RuntimeError(f"No TTS serviceId for language: {lang}")
    _tts_sid_cache[lang] = sid
    return sid


def synthesize(text: str, lang: str, gender: str = "female") -> bytes:
    """Synthesize `text` in `lang` via Bhashini TTS. Returns raw WAV audio bytes."""
    if not INFERENCE_API_KEY:
        raise RuntimeError("BHASHINI_INFERENCE_API_KEY not set")
    text = (text or "").strip()
    if not text:
        raise ValueError("empty text")

    import httpx

    service_id = get_tts_service_id(lang)
    body = {
        "pipelineTasks": [{"taskType": "tts",
                           "config": {"language": {"sourceLanguage": lang},
                                      "serviceId": service_id,
                                      "gender": gender}}],
        "inputData": {"input": [{"source": text}]},
    }
    headers = {"Authorization": INFERENCE_API_KEY, "Content-Type": "application/json"}

    with httpx.Client(timeout=60, verify=_SSL) as client:
        r = client.post(INFERENCE_URL, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    audio_b64 = data["pipelineResponse"][0]["audio"][0]["audioContent"]
    return base64.b64decode(audio_b64)
