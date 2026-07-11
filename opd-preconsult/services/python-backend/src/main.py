import logging
import os

from fastapi import FastAPI, Request, Depends
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .routers import llm, triage, report, ocr, prescription, scribe, drugs, audio, transcribe, tts
from .llm_client import LLMUnavailable
from .auth import require_auth
from . import drug_repo

logger = logging.getLogger(__name__)

_IS_PROD = (os.environ.get("NODE_ENV") or "").lower() == "production"

app = FastAPI(title="OPD Pre-Consult Python Backend")


def _validate_startup_config() -> None:
    """§7a — fail closed in production on default datastore credentials (mirrors
    the node JWT_SECRET / POSTGRES_PASSWORD guards). No-op in dev."""
    if not _IS_PROD:
        return
    weak = {"", "changeme", "changeme_in_production", "password", "postgres"}
    problems = []
    if not os.environ.get("DATABASE_URL") and os.environ.get("POSTGRES_PASSWORD", "changeme_in_production") in weak:
        problems.append("POSTGRES_PASSWORD is default/weak")
    if os.environ.get("MINIO_ACCESS_KEY", "minioadmin") in {"", "minioadmin"}:
        problems.append("MINIO_ACCESS_KEY is the default (minioadmin)")
    if os.environ.get("MINIO_SECRET_KEY", "changeme_in_production") in weak:
        problems.append("MINIO_SECRET_KEY is default/weak")
    if problems:
        raise RuntimeError(
            "[config] Refusing to start in production: " + "; ".join(problems)
            + ". Set strong values (see scripts/gen-secrets.js)."
        )


_validate_startup_config()

# The app is same-origin (browser → gateway → here), so CORS isn't needed for it.
# §7a — dev is permissive (`*`); in production we DO NOT default to `*` — only the
# explicitly configured origins are allowed (CORS_ALLOW_ORIGINS=https://opd.hospital.in,
# comma-separated), and with none set no cross-origin is allowed (same-origin only).
_cors_default = "*" if not _IS_PROD else ""
_cors_origins = [o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", _cors_default).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(LLMUnavailable)
async def llm_unavailable_handler(request: Request, exc: LLMUnavailable):
    # No usable LLM provider — degrade gracefully with a clear, actionable message.
    logger.warning("LLM unavailable on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=503, content={"error": str(exc)})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    # Log the full error server-side; return a generic message so internals
    # (stack traces, DB details) are never leaked to the client.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


# All routers below require a valid login JWT (verified against the shared
# JWT_SECRET). /health stays open. The audio, ocr and transcribe routers gate
# per-route internally, because each has one endpoint consumed as a media <src>
# or a public health check that can't carry an Authorization header:
#   audio      → /clip/{id} (<audio src>): no JWT, but requires a short-lived
#                HMAC signature minted by the authenticated /session/{id} list
#   ocr        → /documents/image/{id} (<img src>): same, minted by /documents/{id}
#   transcribe → /health stays open
# See media_urls.py — the media ids are no longer standalone bearer capabilities.
_auth = [Depends(require_auth)]
app.include_router(llm.router, dependencies=_auth)
app.include_router(triage.router, dependencies=_auth)
app.include_router(report.router, dependencies=_auth)
app.include_router(ocr.router)
app.include_router(prescription.router, dependencies=_auth)
app.include_router(scribe.router, dependencies=_auth)
app.include_router(drugs.router, dependencies=_auth)
app.include_router(audio.router)
app.include_router(transcribe.router)
app.include_router(tts.router, dependencies=_auth)

@app.on_event("startup")
def _init_drug_formulary():
    # Ensure the drug/interaction tables exist and are seeded from the built-in
    # defaults (only if empty). Non-fatal — the engine falls back to in-code data.
    drug_repo.init()


@app.get("/health")
async def health():
    return {"status": "ok"}
