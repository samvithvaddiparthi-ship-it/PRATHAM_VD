import os
import json
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from ..db import query, execute

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/triage", tags=["triage"])

# Triage is MONOTONIC (non-decreasing) for the automated pipeline: this holistic
# evaluator may ESCALATE a session but must never silently DOWNGRADE a level that
# a per-question safety tripwire already raised during the interview (e.g. "chest
# pain? -> yes" flags RED via node's questionnaire.js). Downgrading is a clinical
# decision reserved for a human (doctor). Preserving the higher level keeps the
# patient-facing message, the queue ordering, and the RED nursing alert all
# consistent with what the patient was already told.
_SEVERITY = {"GREEN": 0, "AMBER": 1, "RED": 2}

def _more_severe(a: str, b: str) -> str:
    return a if _SEVERITY.get(a, 0) >= _SEVERITY.get(b, 0) else b

# Redis for publishing RED alerts to nursing station SSE
_redis = None
def _get_redis():
    global _redis
    if _redis is None:
        redis_url = os.environ.get("REDIS_URL")
        if redis_url:
            try:
                import redis
                _redis = redis.from_url(redis_url)
            except Exception:
                _redis = False  # Mark as unavailable
    return _redis if _redis else None

class TriageRequest(BaseModel):
    session_id: str

class TriageResponse(BaseModel):
    level: str
    triggered_rules: list

@router.post("/evaluate", response_model=TriageResponse)
async def evaluate(req: TriageRequest):
    # Load answers
    answers_rows = query(
        "SELECT question_id, answer_raw FROM session_answers WHERE session_id = %s",
        (req.session_id,),
    )
    answers = {a["question_id"]: (a["answer_raw"] or "").lower() for a in answers_rows}

    # Load vitals
    vitals_rows = query(
        "SELECT * FROM session_vitals WHERE session_id = %s ORDER BY recorded_at DESC LIMIT 1",
        (req.session_id,),
    )
    vitals = vitals_rows[0] if vitals_rows else {}

    triggered = []
    level = "GREEN"

    # RED rules
    if answers.get("q_chest_pain") == "yes" and answers.get("q_chest_pain_radiation") == "yes":
        triggered.append("chest_pain_with_radiation")
        level = "RED"

    if answers.get("q_syncope") == "yes" and answers.get("q_chest_pain") == "yes":
        triggered.append("syncope_with_chest_pain")
        level = "RED"

    bp_sys = vitals.get("bp_systolic")
    bp_dia = vitals.get("bp_diastolic")
    spo2 = vitals.get("spo2_pct")

    if bp_sys and bp_sys > 180:
        triggered.append("bp_systolic_critical")
        level = "RED"
    if bp_dia and bp_dia > 120:
        triggered.append("bp_diastolic_critical")
        level = "RED"
    # Hypotension — a low systolic (shock) is a critical finding too, not just high BP.
    if bp_sys and bp_sys < 90:
        triggered.append("bp_systolic_hypotension")
        level = "RED"
    if spo2 and spo2 < 90:
        triggered.append("spo2_critical")
        level = "RED"

    # AMBER rules (only if not already RED)
    if level != "RED":
        if answers.get("q_breathlessness") == "at_rest":
            triggered.append("breathlessness_at_rest")
            level = "AMBER"

        if answers.get("q_syncope") == "yes":
            triggered.append("syncope_alone")
            level = "AMBER"

        if bp_sys and 160 <= bp_sys <= 180:
            triggered.append("bp_systolic_elevated")
            level = "AMBER"

    # Never downgrade a level already raised by an interview safety tripwire.
    prior_rows = query("SELECT triage_level FROM sessions WHERE id = %s", (req.session_id,))
    prior_level = (prior_rows[0]["triage_level"] if prior_rows else None) or "GREEN"
    final_level = _more_severe(level, prior_level)
    if final_level != level:
        # A prior tripwire (e.g. chest pain) outranks the holistic score — keep it.
        triggered.append(f"prior_flag_preserved:{prior_level}")
    level = final_level

    # Update session triage level (monotonic — see _more_severe above)
    execute(
        "UPDATE sessions SET triage_level = %s, updated_at = NOW() WHERE id = %s",
        (level, req.session_id),
    )

    # Publish RED alerts to nursing station via Redis
    if level == "RED":
        r = _get_redis()
        if r:
            try:
                # §8e — the alert broadcast is PHI-free: session_id + department +
                # triage only. The nursing dashboard resolves the patient name via
                # an authenticated call keyed on session_id (never over the SSE feed,
                # which any connected client could otherwise read).
                session_rows = query("SELECT department FROM sessions WHERE id = %s", (req.session_id,))
                dept = session_rows[0].get("department", "") if session_rows else ""
                alert = json.dumps({
                    "session_id": req.session_id,
                    "level": level,
                    "triggered_rules": triggered,
                    "department": dept,
                })
                r.publish("triage_alerts", alert)
            except Exception:
                logger.warning("triage Redis publish failed", exc_info=True)

    return TriageResponse(level=level, triggered_rules=triggered)
