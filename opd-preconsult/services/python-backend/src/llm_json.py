"""Best-effort parsing of JSON out of an LLM text response (which may be wrapped
in ``` fences or surrounded by prose). Shared by the OCR and drug-interaction paths."""
import json
import re


def parse_llm_json(raw):
    """Parse a JSON object/array from `raw`. Raises ValueError/JSONDecodeError if
    nothing usable is found."""
    if not raw:
        raise ValueError("empty LLM response")
    s = raw.strip()
    if s.startswith("```"):
        parts = [p for p in s.split("```") if p.strip()]
        if parts:
            s = max(parts, key=len)
        s = re.sub(r"^\s*json", "", s, flags=re.IGNORECASE).strip()
    s = s.strip().strip("`").strip()
    try:
        return json.loads(s)
    except Exception:
        m = re.search(r"(\{.*\}|\[.*\])", s, re.DOTALL)
        if m:
            return json.loads(m.group(1))
        raise


def parse_or_none(raw):
    try:
        return parse_llm_json(raw)
    except Exception:
        return None
