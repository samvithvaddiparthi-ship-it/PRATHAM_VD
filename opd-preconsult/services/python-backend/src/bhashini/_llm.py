"""
Bridges the Bhashini Stage-2 corrector to the main app's LLM client, so medical
correction uses the SAME provider config (Gemini → OpenAI → Anthropic) as the
rest of the backend — instead of a separate key set. Exposes the small surface
medcorrect expects: have_llm / complete_json / last_provider / last_model.
"""
from .. import llm_client

_last = {"provider": "", "model": ""}


def have_llm() -> bool:
    try:
        return llm_client.has_llm()
    except Exception:
        return False


def complete_json(system_prompt: str, user_content: str, max_tokens: int = 1024) -> str:
    # The system prompt instructs the model to return JSON; medcorrect parses it.
    text = llm_client.complete(system_prompt, user_content, max_tokens=max_tokens)
    _last["provider"] = "app-llm"
    return text


def last_provider() -> str:
    return _last["provider"] or "app-llm"


def last_model() -> str:
    return _last["model"] or ""
