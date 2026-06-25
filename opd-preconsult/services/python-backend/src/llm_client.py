"""Unified LLM client — picks Gemini or Claude based on available env vars."""
import os
import base64
import logging

logger = logging.getLogger(__name__)

# Per-call timeout for LLM providers (seconds). Prevents a hung provider from
# blocking a request indefinitely.
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT_SECONDS", "60"))


class LLMUnavailable(RuntimeError):
    """Raised when no LLM provider is configured/usable. Mapped to HTTP 503 so the
    app degrades gracefully (clear message) instead of returning an opaque 500."""


def has_llm():
    """Returns True if any LLM API key is configured."""
    gem = os.getenv("GEMINI_API_KEY", "").strip()
    ant = os.getenv("ANTHROPIC_API_KEY", "").strip()
    oai = os.getenv("OPENAI_API_KEY", "").strip()
    grq = os.getenv("GROQ_API_KEY", "").strip()
    return bool(gem) or bool(grq) or (bool(ant) and ant != "your_key_here") or bool(oai)


def has_vision():
    """Returns True if a vision-capable provider is available."""
    local = os.getenv("LOCAL_VISION_BASE_URL", "").strip()
    oai = os.getenv("OPENAI_API_KEY", "").strip()
    gem = os.getenv("GEMINI_API_KEY", "").strip()
    grq = os.getenv("GROQ_API_KEY", "").strip()
    ant = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return bool(local) or bool(oai) or bool(gem) or bool(grq) or (bool(ant) and ant != "your_key_here")


def complete(system_prompt: str, user_content: str, max_tokens: int = 1024) -> str:
    """
    Send system prompt + user content, get plain text response back.
    Prefers Gemini → Groq → OpenAI → Anthropic.
    Raises Exception on failure — caller should handle.
    """
    gem_key = os.getenv("GEMINI_API_KEY", "").strip()
    grq_key = os.getenv("GROQ_API_KEY", "").strip()
    oai_key = os.getenv("OPENAI_API_KEY", "").strip()
    ant_key = os.getenv("ANTHROPIC_API_KEY", "").strip()

    configured = False

    if gem_key:
        configured = True
        try:
            return _gemini_complete(gem_key, system_prompt, user_content, max_tokens)
        except Exception as e:
            logger.warning(f"Gemini text failed, trying fallback: {e}")

    if grq_key:
        configured = True
        try:
            return _groq_complete(grq_key, system_prompt, user_content, max_tokens)
        except Exception as e:
            logger.warning(f"Groq text failed, trying fallback: {e}")

    if oai_key:
        configured = True
        try:
            return _openai_complete(oai_key, system_prompt, user_content, max_tokens)
        except Exception as e:
            logger.warning(f"OpenAI text failed, trying fallback: {e}")

    if ant_key and ant_key != "your_key_here":
        configured = True
        try:
            return _anthropic_complete(ant_key, system_prompt, user_content, max_tokens)
        except Exception as e:
            logger.warning(f"Anthropic text failed: {e}")

    if configured:
        # Keys exist but every provider failed (e.g. quota/network). Surface as
        # unavailable so callers degrade gracefully.
        raise LLMUnavailable("All configured LLM providers are currently unavailable (e.g. quota/rate limit).")
    raise LLMUnavailable("No LLM API key configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.")


def complete_with_image(system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str = "image/jpeg", max_tokens: int = 1500) -> str:
    """
    Send system prompt + image + text to a vision-capable model.
    Priority: Local (on-shore) → Gemini Vision (free) → Groq Llama-4 Vision (free) → OpenAI GPT-4o → Anthropic Claude Vision
    """
    local_base = os.getenv("LOCAL_VISION_BASE_URL", "").strip()
    gem_key = os.getenv("GEMINI_API_KEY", "").strip()
    grq_key = os.getenv("GROQ_API_KEY", "").strip()
    oai_key = os.getenv("OPENAI_API_KEY", "").strip()
    ant_key = os.getenv("ANTHROPIC_API_KEY", "").strip()

    # On-shore local vision model first when configured (e.g. Ollama-served
    # Qwen2.5-VL). Keeps patient images off third-party servers (DPDP). Falls
    # through to cloud providers if the local endpoint is unreachable.
    if local_base:
        try:
            return _local_vision_complete(local_base, system_prompt, user_text, image_bytes, mime_type, max_tokens)
        except Exception as e:
            logger.warning(f"Local vision failed, trying cloud: {e}")

    # Try Gemini first (free tier)
    if gem_key:
        try:
            return _gemini_vision_complete(gem_key, system_prompt, user_text, image_bytes, mime_type, max_tokens)
        except Exception as e:
            logger.warning(f"Gemini vision failed, trying Groq: {e}")

    # Groq multimodal (Llama 4 Scout) — free; the main fallback when Gemini's
    # daily quota is spent, so OCR doesn't silently drop to local Tesseract.
    if grq_key:
        try:
            return _groq_vision_complete(grq_key, system_prompt, user_text, image_bytes, mime_type, max_tokens)
        except Exception as e:
            logger.warning(f"Groq vision failed, trying OpenAI: {e}")

    # Fall back to OpenAI GPT-4o
    if oai_key:
        try:
            return _openai_vision_complete(oai_key, system_prompt, user_text, image_bytes, mime_type, max_tokens)
        except Exception as e:
            logger.warning(f"OpenAI vision failed, trying Anthropic: {e}")

    # Fall back to Anthropic Claude vision
    if ant_key and ant_key != "your_key_here":
        try:
            return _anthropic_vision_complete(ant_key, system_prompt, user_text, image_bytes, mime_type, max_tokens)
        except Exception as e:
            logger.warning(f"Anthropic vision failed: {e}")

    raise LLMUnavailable("All vision LLM providers failed or no API keys configured.")


def _gemini_client(api_key: str):
    """Gemini client with a request timeout when the SDK supports it."""
    from google import genai
    try:
        from google.genai import types
        return genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=LLM_TIMEOUT * 1000))
    except Exception:
        return genai.Client(api_key=api_key)  # older SDK — no http_options


# ── Text-only backends ────────────────────────────────────────────────────────

def _gemini_config_kwargs(types_module, system_prompt: str, max_tokens: int, temperature: float) -> dict:
    """
    Build kwargs for GenerateContentConfig, disabling Gemini 2.5 'thinking' when
    the installed SDK supports it. Thinking burns output tokens before the answer
    is written; for structured extraction we don't need it, and disabling it is
    faster, cheaper, and avoids truncating the JSON. Falls back gracefully on
    older SDKs that don't support thinking_budget — the call still works.
    """
    kwargs = dict(
        system_instruction=system_prompt,
        max_output_tokens=max_tokens,
        temperature=temperature,
    )
    try:
        kwargs["thinking_config"] = types_module.ThinkingConfig(thinking_budget=0)
    except Exception:
        pass  # SDK too old — leave thinking on; high max_tokens prevents truncation
    return kwargs


def _gemini_complete(api_key: str, system_prompt: str, user_content: str, max_tokens: int) -> str:
    from google.genai import types

    client = _gemini_client(api_key)
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    response = client.models.generate_content(
        model=model,
        contents=user_content,
        config=types.GenerateContentConfig(**_gemini_config_kwargs(types, system_prompt, max_tokens, 0.3)),
    )
    return response.text or ""


def _openai_complete(api_key: str, system_prompt: str, user_content: str, max_tokens: int) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=api_key, timeout=LLM_TIMEOUT)
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=max_tokens,
        temperature=0.3,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return response.choices[0].message.content or ""


def _groq_complete(api_key: str, system_prompt: str, user_content: str, max_tokens: int) -> str:
    """Groq — free, fast, and OpenAI-API-compatible, so we reuse the OpenAI SDK
    pointed at Groq's endpoint. Model defaults to Llama 3.3 70B; override with
    GROQ_MODEL. A handy free fallback when the Gemini free-tier quota runs out."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url="https://api.groq.com/openai/v1", timeout=LLM_TIMEOUT)
    model = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0.3,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return response.choices[0].message.content or ""


def _anthropic_complete(api_key: str, system_prompt: str, user_content: str, max_tokens: int) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key, timeout=LLM_TIMEOUT)
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")

    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{"role": "user", "content": user_content}],
    )
    return response.content[0].text


# ── Vision backends ───────────────────────────────────────────────────────────

def _openai_vision_complete(api_key: str, system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str, max_tokens: int) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=api_key, timeout=LLM_TIMEOUT)
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=max_tokens,
        temperature=0.1,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
                    {"type": "text", "text": user_text},
                ],
            },
        ],
    )
    return response.choices[0].message.content or ""


def _local_vision_complete(base_url: str, system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str, max_tokens: int) -> str:
    """On-shore local vision model via an OpenAI-compatible endpoint (e.g. Ollama
    serving Qwen2.5-VL at http://host:11434/v1). Same image_url format as the cloud
    vision paths, so the only difference is base_url + model. Patient images never
    leave the local network — the DPDP-clean OCR path. Configure with
    LOCAL_VISION_BASE_URL, LOCAL_VISION_MODEL, optional LOCAL_VISION_TIMEOUT."""
    from openai import OpenAI

    timeout = int(os.getenv("LOCAL_VISION_TIMEOUT", "300"))  # local GPUs are slower
    api_key = os.getenv("LOCAL_VISION_API_KEY", "ollama")    # Ollama ignores the key
    model = os.getenv("LOCAL_VISION_MODEL", "qwen2.5vl:7b")
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0.1,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
                    {"type": "text", "text": user_text},
                ],
            },
        ],
    )
    return response.choices[0].message.content or ""


def _groq_vision_complete(api_key: str, system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str, max_tokens: int) -> str:
    """Groq multimodal vision via its OpenAI-compatible API. Default model is
    Llama 4 Scout (override with GROQ_VISION_MODEL). Same image_url format as the
    OpenAI vision path. Free fallback for when the Gemini quota is exhausted."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url="https://api.groq.com/openai/v1", timeout=LLM_TIMEOUT)
    model = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        temperature=0.1,
        messages=[
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64}"}},
                    {"type": "text", "text": user_text},
                ],
            },
        ],
    )
    return response.choices[0].message.content or ""


def _gemini_vision_complete(api_key: str, system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str, max_tokens: int) -> str:
    from google.genai import types

    client = _gemini_client(api_key)
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    response = client.models.generate_content(
        model=model,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            types.Part.from_text(text=user_text),
        ],
        config=types.GenerateContentConfig(**_gemini_config_kwargs(types, system_prompt, max_tokens, 0.1)),
    )
    return response.text or ""


def _anthropic_vision_complete(api_key: str, system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str, max_tokens: int) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key, timeout=LLM_TIMEOUT)
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_prompt,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": b64}},
                {"type": "text", "text": user_text},
            ],
        }],
    )
    return response.content[0].text
