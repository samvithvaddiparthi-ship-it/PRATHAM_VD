"""B7 — access audit: record WHO viewed a patient's PHI.

The doctor dashboard and HIS admin load a patient's clinical summary via
`GET /api/report/{session_id}` — that fetch is the meaningful "a clinician
opened this patient's record" event. We stamp it into the SAME `audit_log`
table node-backend already uses (event_type = 'patient_viewed'), so there's one
unified access trail (logins, consultation actions, and now views).

Two design constraints from the pilot checklist ("useful IF it won't clutter or
slow down the app"):

  * No clutter — an in-memory dedup window collapses repeated fetches of the same
    patient by the same actor (the dashboard re-fetches a report several times per
    consultation) into a single audit row per window.
  * No slowdown — the write is best-effort and fully swallowed on error; it can
    never delay or break serving the report. No new table, index, or dependency.
"""
import json
import logging
import os
import time

from .db import execute

logger = logging.getLogger(__name__)

# How long to suppress duplicate view rows for the same (actor, session), seconds.
_DEDUP_WINDOW_S = int(os.getenv("VIEW_AUDIT_DEDUP_SECONDS", "300"))

# (actor, session_id) -> last-logged monotonic timestamp. Bounded below.
_last_logged: dict[tuple[str, str], float] = {}
_MAX_ENTRIES = 5000


def _actor(claims: dict) -> str:
    """A human-readable actor id from the JWT claims (never PHI)."""
    if not claims:
        return "unknown"
    return (
        claims.get("doctor_name")
        or claims.get("admin_name")
        or claims.get("doctor_id")
        or claims.get("role")
        or "unknown"
    )


def record_view(session_id: str, claims: dict) -> None:
    """Fire-and-forget: log that `actor` viewed `session_id`, deduped per window.

    Safe to call on every report fetch — cheap dict lookup, occasional INSERT,
    never raises into the request path.
    """
    try:
        if not session_id:
            return
        actor = _actor(claims)
        role = (claims or {}).get("role") or "unknown"
        now = time.monotonic()
        key = (actor, session_id)

        last = _last_logged.get(key)
        if last is not None and (now - last) < _DEDUP_WINDOW_S:
            return  # within the window — already logged, don't spam

        # Simple bound so the dedup map can't grow without limit in a long run.
        if len(_last_logged) > _MAX_ENTRIES:
            _last_logged.clear()
        _last_logged[key] = now

        execute(
            """INSERT INTO audit_log (session_id, event_type, actor, payload)
               VALUES (%s, 'patient_viewed', %s, %s::jsonb)""",
            (session_id, str(actor), json.dumps({"via": "report", "role": role})),
        )
    except Exception:  # never let auditing break the actual request
        logger.warning("view_audit non-fatal error", exc_info=True)


def record_event(event_type: str, actor: str, session_id=None, extra: dict = None, dedup_key: str = None) -> None:
    """§6a — generic PHI-free audit write, same non-blocking dedup window as
    record_view. Use for document-image views, audio playback, etc. `extra` and
    the payload must contain IDs only (never names/phones/transcripts). `dedup_key`
    collapses repeated identical events (e.g. an <img> re-fetched on each render)
    within the window; defaults to the session id.
    """
    try:
        now = time.monotonic()
        key = ("evt", event_type, dedup_key or session_id or "")
        last = _last_logged.get(key)
        if last is not None and (now - last) < _DEDUP_WINDOW_S:
            return
        if len(_last_logged) > _MAX_ENTRIES:
            _last_logged.clear()
        _last_logged[key] = now
        execute(
            """INSERT INTO audit_log (session_id, event_type, actor, payload)
               VALUES (%s, %s, %s, %s::jsonb)""",
            (session_id, event_type, str(actor), json.dumps(extra or {})),
        )
    except Exception:
        logger.warning("view_audit record_event non-fatal", exc_info=True)
