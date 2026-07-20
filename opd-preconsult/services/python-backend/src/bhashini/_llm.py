"""
LLM bridge for the Bhashini Stage-2 medical correction.

DETERMINISTIC BY DEFAULT: the medical-correction LLM is OFF unless
BHASHINI_STAGE2_LLM is explicitly enabled. This makes the in-app pipeline behave
EXACTLY like the standalone lab (which the user validated), running lexicon +
de-stutter + context-gated name matching only. The LLM layer can be switched on
later (set BHASHINI_STAGE2_LLM=1) once it's tested on a real mic.
"""
import os

from .. import llm_client

_last = {"provider": "", "model": ""}


def _enabled() -> bool:
    return os.getenv("BHASHINI_STAGE2_LLM", "").strip().lower() in ("1", "true", "yes", "on")


def have_llm() -> bool:
    if not _enabled():
        return False
    try:
        return llm_client.has_llm()
    except Exception:
        return False


def complete_json(system_prompt: str, user_content: str, max_tokens: int = 1024) -> str:
    text = llm_client.complete(system_prompt, user_content, max_tokens=max_tokens)
    _last["provider"] = "app-llm"
    return text


def last_provider() -> str:
    return _last["provider"] or "app-llm"


def last_model() -> str:
    return _last["model"] or ""
