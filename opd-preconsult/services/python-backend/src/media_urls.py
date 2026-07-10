"""Short-lived signed URLs for the two PHI media routes (§5b).

`GET /api/ocr/documents/image/{doc_id}` and `GET /api/audio/clip/{clip_id}` are
consumed as `<img src>` / `<audio src>`, which cannot carry an Authorization
header. They used to be fully open: the object UUID was the only protection, so
a leaked id was a permanent, unauthenticated bearer capability on a patient's
prescription photo or voice recording.

Instead of a JWT, each media reference is now minted by the *authenticated* list
endpoint that returns it (`/api/ocr/documents/{session_id}`,
`/api/audio/session/{session_id}`) as a capability URL:

    /api/ocr/documents/image/<id>?exp=<unix-ts>&sig=<HMAC-SHA256 hex>

The signature covers `kind:id:exp`, so a signature minted for a document cannot
be replayed against an audio clip (or vice versa), and the URL dies at `exp`.
Verification is a constant-time compare.

Key: `MEDIA_URL_SECRET` if set, else the shared `JWT_SECRET` (which is already
required and fail-closed everywhere). Rotating either invalidates outstanding
media URLs — harmless, the page re-mints them on next load.
"""
import hashlib
import hmac
import os
import time

from fastapi import HTTPException

from .auth import _WEAK_SECRETS

# How long a minted media URL stays valid. The doctor lists a patient's clips and
# may click play minutes later, so this is longer than a page load but well short
# of the 24h presigned default that §2 of the gap analysis called excessive.
DEFAULT_TTL_SECONDS = int(os.getenv("MEDIA_URL_TTL_SECONDS", "900"))

# Namespaces — bound into the signature so a doc URL can't be replayed as audio.
KIND_DOC = "doc"
KIND_CLIP = "clip"


def _secret() -> str:
    s = (os.environ.get("MEDIA_URL_SECRET") or os.environ.get("JWT_SECRET") or "").strip()
    if s in _WEAK_SECRETS or len(s) < 16:
        # 503, not 403: a misconfigured server, not a bad client request.
        raise HTTPException(status_code=503, detail="Media signing not configured")
    return s


def _signature(kind: str, obj_id: str, exp: int) -> str:
    msg = f"{kind}:{obj_id}:{exp}".encode()
    return hmac.new(_secret().encode(), msg, hashlib.sha256).hexdigest()


def signed_query(kind: str, obj_id: str, ttl_seconds: int | None = None) -> str:
    """Return the `?exp=…&sig=…` query string to append to a media route."""
    exp = int(time.time()) + int(ttl_seconds or DEFAULT_TTL_SECONDS)
    return f"?exp={exp}&sig={_signature(kind, str(obj_id), exp)}"


def document_image_url(doc_id: str, ttl_seconds: int | None = None) -> str:
    return f"/api/ocr/documents/image/{doc_id}{signed_query(KIND_DOC, doc_id, ttl_seconds)}"


def audio_clip_url(clip_id: str, ttl_seconds: int | None = None) -> str:
    return f"/api/audio/clip/{clip_id}{signed_query(KIND_CLIP, clip_id, ttl_seconds)}"


def verify(kind: str, obj_id: str, exp: int | None, sig: str | None) -> None:
    """Raise 403 unless `sig` is a live signature over `kind:obj_id:exp`."""
    if exp is None or not sig:
        raise HTTPException(status_code=403, detail="Missing or invalid media signature")
    if int(exp) < int(time.time()):
        raise HTTPException(status_code=403, detail="Media link expired")
    expected = _signature(kind, str(obj_id), int(exp))
    if not hmac.compare_digest(expected, str(sig)):
        raise HTTPException(status_code=403, detail="Missing or invalid media signature")
