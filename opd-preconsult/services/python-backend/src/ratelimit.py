"""§8c — lightweight Redis-backed fixed-window rate limiting for the expensive /
abusable python endpoints (cloud OCR, report/LLM, scribe transcription) and the
signed media routes.

Keyed per client IP + route bucket. Redis is already in the stack (triage alerts);
if it is unavailable we FAIL OPEN (no limiting) rather than reject traffic — the
limiter is abuse mitigation, not an auth control. Limits are env-tunable.

Usage:
    from ..ratelimit import rate_limit
    _rl = rate_limit("ocr_process", default_max=20, default_window=60)
    @router.post("/process", dependencies=[Depends(_rl)])
"""
import logging
import os

from fastapi import Request, HTTPException

logger = logging.getLogger(__name__)

_redis = None
_redis_init = False


def _get_redis():
    global _redis, _redis_init
    if _redis_init:
        return _redis
    _redis_init = True
    url = os.environ.get("REDIS_URL")
    if not url:
        logger.warning("ratelimit: REDIS_URL unset — rate limiting disabled (fail open)")
        return None
    try:
        import redis
        _redis = redis.from_url(url)
    except Exception:
        logger.warning("ratelimit: redis unavailable — rate limiting disabled (fail open)", exc_info=True)
        _redis = None
    return _redis


def _client_ip(request: Request) -> str:
    # Behind the proxy the first X-Forwarded-For hop is the real client.
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(name: str, default_max: int, default_window: int):
    """Build a FastAPI dependency enforcing `max` requests per `window` seconds per
    client IP for the `name` bucket. Overridable via env:
        RATELIMIT_<NAME>_MAX, RATELIMIT_<NAME>_WINDOW  (NAME upper-cased).
    """
    env = name.upper()
    max_requests = int(os.environ.get(f"RATELIMIT_{env}_MAX", str(default_max)))
    window_seconds = int(os.environ.get(f"RATELIMIT_{env}_WINDOW", str(default_window)))

    async def _dep(request: Request):
        if max_requests <= 0:
            return  # explicitly disabled
        r = _get_redis()
        if not r:
            return  # fail open
        ip = _client_ip(request)
        key = f"ratelimit:{name}:{ip}"
        try:
            n = r.incr(key)
            if n == 1:
                r.expire(key, window_seconds)
            if n > max_requests:
                ttl = r.ttl(key)
                retry = ttl if (ttl and ttl > 0) else window_seconds
                raise HTTPException(
                    status_code=429,
                    detail="Too many requests. Please slow down.",
                    headers={"Retry-After": str(retry)},
                )
        except HTTPException:
            raise
        except Exception:
            logger.warning("ratelimit check failed for %s (fail open)", name, exc_info=True)

    return _dep
