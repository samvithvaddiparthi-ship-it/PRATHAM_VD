import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from .routers import llm, triage, report, ocr, prescription, scribe, drugs, audio, transcribe, tts
from .llm_client import LLMUnavailable
from . import drug_repo

logger = logging.getLogger(__name__)

app = FastAPI(title="OPD Pre-Consult Python Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


app.include_router(llm.router)
app.include_router(triage.router)
app.include_router(report.router)
app.include_router(ocr.router)
app.include_router(prescription.router)
app.include_router(scribe.router)
app.include_router(drugs.router)
app.include_router(audio.router)
app.include_router(transcribe.router)
app.include_router(tts.router)

@app.on_event("startup")
def _init_drug_formulary():
    # Ensure the drug/interaction tables exist and are seeded from the built-in
    # defaults (only if empty). Non-fatal — the engine falls back to in-code data.
    drug_repo.init()


@app.get("/health")
async def health():
    return {"status": "ok"}
