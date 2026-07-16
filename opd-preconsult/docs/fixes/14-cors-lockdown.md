# 14 — Python CORS defaults to `*`

**Severity:** Low · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/python-backend/src/main.py`
- `.env.example`

Nothing else.

## The problem

`services/python-backend/src/main.py`:

```python
_cors_origins = [o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

The comment above it is honest about the intent — the app is same-origin, so CORS is not
needed at all, and `*` is a dev convenience. The problem is that the *default* is the
permissive value, so a production deploy that simply forgets to set `CORS_ALLOW_ORIGINS`
silently ships `Access-Control-Allow-Origin: *`.

**How bad is it, really?** Not very. `allow_credentials` is not set (defaults `False`),
and the app authenticates with a Bearer token held in JS memory — never a cookie. A
malicious page therefore cannot make an *authenticated* cross-origin request, because it
has no way to obtain the token. So `*` here does not directly leak PHI.

It does mean any website can call the unauthenticated endpoints and read their responses,
and it removes a layer of defence-in-depth for free. Fix it because it is nearly zero
effort, not because it is on fire.

## Decisions (already made — do not deviate)

1. **Fail closed in production.** If the app is running in production and
   `CORS_ALLOW_ORIGINS` is unset or `*`, raise at startup. A hospital deploy that boots
   with `*` is a misconfiguration, and this matches how `middleware/auth.js` already
   treats a weak `JWT_SECRET` (hard-fail in prod, warn in dev).
2. **Keep `*` as the dev default**, with a one-line warning at startup.
3. **Detect production via `NODE_ENV`.** Both services read the same `.env`; the node
   backend already keys off `NODE_ENV=production`, and `docker-compose.prod.yml` sets it.
   Do not invent a second variable name.
4. **Never allow `*` together with credentials.** Do not set `allow_credentials=True`
   in this task — nothing needs it, and combined with `*` FastAPI would silently refuse.
5. Tighten `allow_methods` / `allow_headers` only when origins are explicit. With `*`
   origins in dev, leave them `*` so nothing breaks locally.

## Required change

Replace the CORS block in `services/python-backend/src/main.py`:

```python
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
```

with:

```python
# ── CORS ─────────────────────────────────────────────────────────────────────
# The app is same-origin (browser → gateway → here), so CORS is not needed for it at
# all. `*` stays as a dev convenience, but a production deploy that forgets to set
# CORS_ALLOW_ORIGINS must not silently ship it — fail closed, the way node's
# middleware/auth.js fails closed on a weak JWT_SECRET.
#
# Note we never set allow_credentials: auth is a Bearer token held in JS memory, not a
# cookie, so a cross-origin page has no way to obtain it. `*` is therefore not a direct
# PHI leak — this is defence in depth.
_IS_PROD = os.environ.get("NODE_ENV") == "production"
_cors_raw = os.environ.get("CORS_ALLOW_ORIGINS", "*").strip()
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()]

if _IS_PROD and (not _cors_origins or "*" in _cors_origins):
    raise RuntimeError(
        "[cors] CORS_ALLOW_ORIGINS is unset or '*' in production. Set it to your real "
        "origin(s), comma-separated, e.g. CORS_ALLOW_ORIGINS=https://opd.hospital.in"
    )

if "*" in _cors_origins:
    logger.warning(
        "[cors] allowing all origins ('*') — dev only. Set CORS_ALLOW_ORIGINS before deploying."
    )

_wildcard = "*" in _cors_origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    # With an explicit origin list we can be specific; with '*' (dev) stay permissive
    # so nothing breaks locally.
    allow_methods=["*"] if _wildcard else ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"] if _wildcard else ["Authorization", "Content-Type"],
)
```

`logger` is already defined above this block (`logger = logging.getLogger(__name__)`).
`os` is already imported. Do not re-import either.

## Gotcha

The `raise RuntimeError` runs at **import time**, before uvicorn binds a port. In
production the container will exit immediately with that message in the logs — which is
the intended behaviour, and matches `middleware/auth.js` throwing on a weak `JWT_SECRET`.
Make sure whoever deploys knows to set the variable; that is what the `.env.example` note
below is for.

## `.env.example`

Replace the existing CORS lines:

```bash
# CORS — lock the python-backend to your domain in production (comma-separated).
# Default '*' is fine for local dev. e.g. CORS_ALLOW_ORIGINS=https://opd.hospital.in
# CORS_ALLOW_ORIGINS=
```

with:

```bash
# CORS for python-backend. REQUIRED in production: with NODE_ENV=production the service
# REFUSES TO START if this is unset or '*'. Comma-separated list of exact origins.
# Local dev may leave it unset (defaults to '*', logs a warning).
# CORS_ALLOW_ORIGINS=https://opd.hospital.in
```

## Acceptance criteria

- [ ] `NODE_ENV=production` + no `CORS_ALLOW_ORIGINS` → import raises `RuntimeError`.
- [ ] `NODE_ENV=production` + `CORS_ALLOW_ORIGINS=*` → import raises `RuntimeError`.
- [ ] `NODE_ENV=production` + `CORS_ALLOW_ORIGINS=https://x.example` → starts, and
      `allow_methods` / `allow_headers` are the explicit lists, not `*`.
- [ ] No `NODE_ENV` + nothing set → starts, logs the `[cors] allowing all origins` warning.
- [ ] `allow_credentials` is not passed anywhere.
- [ ] `docker compose up` (dev) is unaffected.
- [ ] The 32 existing tests still pass.

## How to verify

```powershell
cd services\python-backend
python -m compileall -q src
python -m pytest tests\ -q
Select-String -Path src\main.py -Pattern 'allow_credentials'
# must produce no matches
```

The import-time behaviour, without needing a DB (`main.py` only touches the DB on the
startup event, not at import):

```powershell
# dev: warns, does not raise
python -c "import src.main" 2>&1 | Select-String "allowing all origins"

# production, unset: must raise
$env:NODE_ENV='production'
python -c "import src.main"
# expect RuntimeError: [cors] CORS_ALLOW_ORIGINS is unset or '*' in production...

# production, wildcard: must raise
$env:CORS_ALLOW_ORIGINS='*'
python -c "import src.main"
# expect the same RuntimeError

# production, explicit: must succeed
$env:CORS_ALLOW_ORIGINS='https://opd.hospital.in'
python -c "import src.main; print('started ok')"

Remove-Item Env:NODE_ENV, Env:CORS_ALLOW_ORIGINS
```

If `import src.main` fails on a missing package (`fastapi`, `PIL`, `pytesseract`), run
these inside the container instead:

```powershell
docker compose exec python-backend python -c "import src.main; print('ok')"
```

Then confirm the running app is unchanged:

```powershell
docker compose up -d --build
curl.exe -s http://localhost/api/tts/health
```

## Done when

The two production cases raise, the explicit-origin case starts, dev still warns rather
than raising, and `docker compose up` is unaffected.
