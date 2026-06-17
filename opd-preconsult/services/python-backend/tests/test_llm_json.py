"""Tests for the LLM-JSON extraction helper used by the AI interaction fallback."""
from src.llm_json import parse_llm_json, parse_or_none


def test_plain_array():
    assert parse_llm_json('[{"a": 1}]') == [{"a": 1}]


def test_fenced_json_block():
    raw = '```json\n[{"drug_a": "x", "severity": "warn"}]\n```'
    assert parse_llm_json(raw) == [{"drug_a": "x", "severity": "warn"}]


def test_prose_around_json():
    raw = 'Here are the interactions:\n[{"severity": "block"}]\nHope that helps!'
    assert parse_llm_json(raw) == [{"severity": "block"}]


def test_object_payload():
    assert parse_llm_json('{"k": "v"}') == {"k": "v"}


def test_parse_or_none_on_garbage():
    assert parse_or_none("not json at all") is None
    assert parse_or_none("") is None
