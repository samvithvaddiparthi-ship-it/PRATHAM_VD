"""Unified LLM client — picks Gemini or Claude based on available env vars."""
import os
import base64
import logging

logger = logging.getLogger(__name__)


def has_llm():
    """Returns True if any LLM API key is configured."""
    gem = os.getenv("GEMINI_API_KEY", "").strip()
    ant = os.getenv("ANTHROPIC_API_KEY", "").strip()
    oai = os.getenv("OPENAI_API_KEY", "").strip()
    return bool(gem) or (bool(ant) and ant != "your_key_here") or bool(oai)


def has_vision():
    """Returns True if a vision-capable API key is available."""
    oai = os.getenv("OPENAI_API_KEY", "").strip()
    gem = os.getenv("GEMINI_API_KEY", "").strip()
    ant = os.getenv("ANTHROPIC_API_KEY", "").strip()
    return bool(oai) or bool(gem) or (bool(ant) and ant != "your_key_here")


def complete(system_prompt: str, user_content: str, max_tokens: int = 1024) -> str:
    """
    Send system prompt + user content, get plain text response back.
    Prefers Gemini → OpenAI → Anthropic.
    Raises Exception on failure — caller should handle.
    """
    gem_key = os.getenv("GEMINI_API_KEY", "").strip()
    oai_key = os.getenv("OPENAI_API_KEY", "").strip()
    ant_key = os.getenv("ANTHROPIC_API_KEY", "").strip()

    if gem_key:
        try:
            return _gemini_complete(gem_key, system_prompt, user_content, max_tokens)
        except Exception as e:
            logger.warning(f"Gemini text failed, trying fallback: {e}")

    if oai_key:
        return _openai_complete(oai_key, system_prompt, user_content, max_tokens)

    if ant_key and ant_key != "your_key_here":
        return _anthropic_complete(ant_key, system_prompt, user_content, max_tokens)

    raise RuntimeError("No LLM API key configured")


def complete_with_image(system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str = "image/jpeg", max_tokens: int = 1500) -> str:
    """
    Send system prompt + image + text to a vision-capable model.
    Priority: Gemini Vision (free) → OpenAI GPT-4o → Anthropic Claude Vision
    """
    gem_key = os.getenv("GEMINI_API_KEY", "").strip()
    oai_key = os.getenv("OPENAI_API_KEY", "").strip()
    ant_key = os.getenv("ANTHROPIC_API_KEY", "").strip()

    # Try Gemini first (free tier)
    if gem_key:
        try:
            return _gemini_vision_complete(gem_key, system_prompt, user_text, image_bytes, mime_type, max_tokens)
        except Exception as e:
            logger.warning(f"Gemini vision failed, trying OpenAI: {e}")

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

    raise RuntimeError("All vision LLM providers failed or no API keys configured")


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
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

    response = client.models.generate_content(
        model=model,
        contents=user_content,
        config=types.GenerateContentConfig(**_gemini_config_kwargs(types, system_prompt, max_tokens, 0.3)),
    )
    return response.text or ""


def _openai_complete(api_key: str, system_prompt: str, user_content: str, max_tokens: int) -> str:
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
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


def _anthropic_complete(api_key: str, system_prompt: str, user_content: str, max_tokens: int) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
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

    client = OpenAI(api_key=api_key)
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


def _gemini_vision_complete(api_key: str, system_prompt: str, user_text: str, image_bytes: bytes, mime_type: str, max_tokens: int) -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
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

    client = anthropic.Anthropic(api_key=api_key)
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
