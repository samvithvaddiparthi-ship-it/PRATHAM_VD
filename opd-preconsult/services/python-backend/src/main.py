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

app = FastAPI(title="OPD Pre-Consult Python Backend")

# The app is same-origin (browser → gateway → here), so CORS isn't needed for it;
# `*` is kept as a dev default but should be locked to the real origin in prod via
# CORS_ALLOW_ORIGINS=https://opd.hospital.in (comma-separated).
_cors_origins = [o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", "*").split(",") if o.strip()]
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
#   audio      → /clip/{id} (<audio src>) stays open
#   ocr        → /documents/image/{id} (<img src>) stays open
#   transcribe → /health stays open
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
