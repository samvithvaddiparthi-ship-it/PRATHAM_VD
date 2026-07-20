"""Error tracking (Sentry) — scaffolded, OFF until SENTRY_DSN is set.

Mentor decision 2026-07-20: cloud Sentry. ``init_error_tracking`` initialises the
Sentry SDK only when ``SENTRY_DSN`` is present, so with the DSN unset it is a strict
no-op. Call it once at startup (main.py), before the FastAPI app is created.

PHI never leaves the process: ``send_default_pii`` is off and ``before_send`` strips
request bodies, cookies and auth headers (patient names / phones / answers can live in
any of those). We report the error's type / stack / location, not its data.
"""
import logging
import os

logger = logging.getLogger(__name__)

_REDACT_HEADERS = ("authorization", "cookie", "x-twilio-signature")


def _scrub_event(event, _hint):
    """Drop anything that could carry PHI or secrets before the event is sent."""
    try:
        request = event.get("request")
        if isinstance(request, dict):
            # Body / query can carry patient names, phone numbers, free-text answers.
            request.pop("data", None)
            request.pop("cookies", None)
            request.pop("query_string", None)
            headers = request.get("headers")
            if isinstance(headers, dict):
                for key in list(headers):
                    if key.lower() in _REDACT_HEADERS:
                        headers[key] = "[redacted]"
        event.pop("user", None)
    except Exception:  # scrubbing must never raise
        pass
    return event


def init_error_tracking() -> None:
    dsn = (os.environ.get("SENTRY_DSN") or "").strip()
    if not dsn:
        logger.info("[error-tracking] disabled (set SENTRY_DSN to enable)")
        return
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("SENTRY_ENVIRONMENT")
            or os.environ.get("NODE_ENV")
            or "development",
            traces_sample_rate=0,      # errors only — no performance tracing
            send_default_pii=False,    # never attach IP / cookies / user
            before_send=_scrub_event,
        )
        logger.info("[error-tracking] Sentry initialised (errors only, PHI scrubbed)")
    except Exception as exc:  # a missing/broken SDK must never take the app down
        logger.error("[error-tracking] Sentry init failed (continuing without it): %s", exc)
