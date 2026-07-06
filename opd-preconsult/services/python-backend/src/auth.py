"""Cross-service auth for the python-backend.

The python-backend endpoints are called directly by the browser (through the
gateway) carrying the SAME JWT that node-backend issues at login/scan
(HS256, `jsonwebtoken`, 24h exp, signed with JWT_SECRET). This module verifies
that token so only authenticated patients/doctors can reach OCR / triage /
report / scribe / prescription checks / etc.

Dependency-free by design (stdlib only) so we don't add a pip package — mirrors
node's `services/node-backend/src/middleware/auth.js`.
"""
import base64
import hashlib
import hmac
import json
import os
import time

from fastapi import Header, HTTPException

# Known placeholder / dev values are rejected so a misconfigured deploy can't run
# on a guessable signing key (matches the node side's fail-closed posture).
_WEAK_SECRETS = {
    "", "dev_secret", "changeme", "changeme_in_production",
    "changeme_in_production_use_256bit_random_string", "your_key_here", "secret",
}


def _secret() -> str:
    s = (os.environ.get("JWT_SECRET") or "").strip()
    if s in _WEAK_SECRETS or len(s) < 16:
        # 503, not 401: this is a server misconfiguration, not a bad client token.
        raise HTTPException(status_code=503, detail="Auth not configured")
    return s


def _b64url_decode(seg: str) -> bytes:
    return base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4))


def _verify(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise HTTPException(status_code=401, detail="Invalid token")
    header_b64, payload_b64, sig_b64 = parts

    # Only accept HS256 (what node signs with) — reject alg:none / RS256 confusion.
    try:
        header = json.loads(_b64url_decode(header_b64))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if header.get("alg") != "HS256":
        raise HTTPException(status_code=401, detail="Invalid token")

    expected = hmac.new(_secret().encode(), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
    try:
        got = _b64url_decode(sig_b64)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    if not hmac.compare_digest(expected, got):
        raise HTTPException(status_code=401, detail="Invalid token")

    try:
        claims = json.loads(_b64url_decode(payload_b64))
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    exp = claims.get("exp")
    if exp is not None and time.time() > float(exp):
        raise HTTPException(status_code=401, detail="Token expired")
    return claims


async def require_auth(authorization: str = Header(default="")) -> dict:
    """FastAPI dependency: 401 unless a valid Bearer JWT is present. Returns the
    decoded claims (role, session_id, doctor_id, ...)."""
    if not authorization:
        raise HTTPException(status_code=401, detail="No token provided")
    token = authorization[7:] if authorization[:7].lower() == "bearer " else authorization
    return _verify(token)
