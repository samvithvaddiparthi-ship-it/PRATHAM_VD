"""
Minimal LLM client for the Bhashini lab's Stage-2 medical correction.

Provider-agnostic with a Gemini-first default (the project already ships a
GEMINI_API_KEY). Keys are loaded from bhashini-lab/.env then ../.env (the main
project .env), so no new setup is needed. Falls back OpenAI -> Anthropic if those
keys exist. Returns plain text; the caller parses JSON.

Switch model/provider via env:
    LAB_LLM_PROVIDER = gemini | openai | anthropic   (default: auto)
    LAB_LLM_MODEL    = override the model id
"""
import os
import json
from pathlib import Path

try:
    from dotenv import load_dotenv
    _HERE = Path(__file__).parent
    load_dotenv(_HERE / ".env")
    load_dotenv(_HERE.parent / ".env")  # main project .env (has GEMINI_API_KEY)
except Exception:
    pass

import httpx

try:
    import truststore
    import ssl
    _SSL = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
except Exception:
    _SSL = True

GEMINI_KEY = os.getenv("GEMINI_API_KEY", "").strip()
OPENAI_KEY = os.getenv("OPENAI_API_KEY", "").strip()
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
if ANTHROPIC_KEY in ("your_key_here", "your_anthropic_api_key_here"):
    ANTHROPIC_KEY = ""

PROVIDER = os.getenv("LAB_LLM_PROVIDER", "").strip().lower()

# Defaults chosen for a constrained edit task (fast, strong multilingual).
DEFAULT_MODEL = {
    # gemini-2.5-flash is what the main app uses successfully (for OCR).
    "gemini": os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    "openai": "gpt-4o-mini",
    "anthropic": "claude-haiku-4-5-20251001",
}
MODEL_OVERRIDE = os.getenv("LAB_LLM_MODEL", "").strip()


_KEYS = {"gemini": lambda: GEMINI_KEY, "openai": lambda: OPENAI_KEY, "anthropic": lambda: ANTHROPIC_KEY}
_CALL = {"gemini": lambda *a: _gemini(*a), "openai": lambda *a: _openai(*a), "anthropic": lambda *a: _anthropic(*a)}

# Set to the provider/model actually used by the most recent successful call,
# so the UI can show what produced the correction (may differ from the primary
# if we had to fall back, e.g. Gemini 429 -> OpenAI).
_last_provider = ""
_last_model = ""


def _provider_order():
    """Available providers, primary first (env override honoured), used as a
    fallback chain so a quota/rate-limit on one doesn't kill Stage 2."""
    avail = [p for p in ("gemini", "openai", "anthropic") if _KEYS[p]()]
    if PROVIDER in avail:
        avail = [PROVIDER] + [p for p in avail if p != PROVIDER]
    return avail


def active_provider() -> str:
    order = _provider_order()
    return order[0] if order else ""


def have_llm() -> bool:
    return bool(_provider_order())


def model_name(provider: str = "") -> str:
    provider = provider or active_provider()
    return MODEL_OVERRIDE or DEFAULT_MODEL.get(provider, "")


def last_provider() -> str:
    return _last_provider or active_provider()


def last_model() -> str:
    return _last_model or model_name()


def complete_json(system_prompt: str, user_content: str, max_tokens: int = 1024) -> str:
    """Send system + user, return the model's text (expected JSON). Tries each
    available provider in order until one succeeds."""
    global _last_provider, _last_model
    order = _provider_order()
    if not order:
        raise RuntimeError("No LLM API key configured for Stage-2 correction")
    last_err = None
    for prov in order:
        try:
            out = _CALL[prov](system_prompt, user_content, max_tokens)
            _last_provider, _last_model = prov, model_name(prov)
            return out
        except Exception as e:
            last_err = e
            print(f"[lab-llm] {prov} failed ({type(e).__name__}); trying next provider", flush=True)
    raise last_err


def _gemini(system_prompt, user_content, max_tokens):
    model = model_name()
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent?key={GEMINI_KEY}")
    body = {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_content}]}],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
        },
    }
    with httpx.Client(timeout=60, verify=_SSL) as c:
        r = c.post(url, json=body)
        r.raise_for_status()
        data = r.json()
    return data["candidates"][0]["content"]["parts"][0]["text"]


def _openai(system_prompt, user_content, max_tokens):
    with httpx.Client(timeout=60, verify=_SSL) as c:
        r = c.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            json={
                "model": model_name(),
                "temperature": 0,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_content},
                ],
            },
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


def _anthropic(system_prompt, user_content, max_tokens):
    with httpx.Client(timeout=60, verify=_SSL) as c:
        r = c.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01"},
            json={
                "model": model_name(),
                "max_tokens": max_tokens,
                "temperature": 0,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_content}],
            },
        )
        r.raise_for_status()
        return r.json()["content"][0]["text"]
