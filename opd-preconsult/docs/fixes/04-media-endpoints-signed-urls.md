# 04 — Document images and audio clips are served with no authentication

**Severity:** High · **Effort:** Medium
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/python-backend/src/media_links.py` (new file)
- `services/python-backend/src/routers/ocr.py`
- `services/python-backend/src/routers/audio.py`
- `frontend/src/lib/api.js`
- `frontend/src/app/doctor/page.jsx` (only the audio `src` call site)
- `frontend/src/app/his/page.jsx` (only the document image `src` call site)

Nothing else.

## The problem

Two endpoints serve patient PHI to anyone who knows (or guesses) a UUID:

`services/python-backend/src/routers/ocr.py`:

```python
@router.get("/documents/image/{doc_id}")
async def get_document_image(doc_id: str):
    """Stream the stored image for an uploaded document (for the HIS viewer)."""
```

`services/python-backend/src/routers/audio.py`:

```python
@router.get("/clip/{clip_id}")
async def get_clip(clip_id: str):
```

Both are deliberately unauthenticated because the browser consumes them as
`<img src>` / `<audio src>`, and those tags cannot send an `Authorization` header.
That constraint is real. Open access is not the right answer to it.

The first serves scanned prescriptions and lab reports. The second serves the
patient's own voice describing their symptoms.

## Decisions (already made — do not deviate)

1. **Short-lived HMAC-signed URLs.** An authenticated endpoint mints a URL carrying
   `?exp=<unix>&sig=<hex>`. The media endpoint recomputes the HMAC and rejects a
   bad or expired signature. No cookies, no session state.
2. **Sign with `JWT_SECRET`**, the secret both backends already share. Use stdlib
   `hmac` + `hashlib`. **Do not add a JWT or crypto pip dependency** — `auth.py` is
   deliberately stdlib-only and this must match.
3. **TTL = 300 seconds.** Long enough to render a page, short enough that a leaked
   URL in a log or referrer is worthless.
4. **Bind the signature to the object kind and id**, so a signature minted for an
   audio clip cannot be replayed against a document image.
5. **Minting requires `require_auth` + `assert_session_access`** on the owning
   session — the same rule the rest of the service now uses.
6. Signature comparison uses `hmac.compare_digest`.

## Required change

### 1. New file `services/python-backend/src/media_links.py`

```python
"""Short-lived signed URLs for media served to <img>/<audio> tags.

Those tags cannot send an Authorization header, so the two media endpoints
(ocr.get_document_image, audio.get_clip) cannot be gated by require_auth. Instead
an AUTHENTICATED endpoint mints a URL carrying an expiry and an HMAC over
(kind, object_id, expiry); the media endpoint verifies it before streaming bytes.

Signed with the shared JWT_SECRET. Stdlib only, matching src/auth.py — do not add
a dependency for this.
"""
import hashlib
import hmac
import os
import time

from fastapi import HTTPException

# How long a minted media URL stays valid. Long enough to render a page; short
# enough that a URL leaked into a log or Referer header is already dead.
MEDIA_URL_TTL_SECONDS = 300


def _secret() -> bytes:
    s = (os.environ.get("JWT_SECRET") or "").strip()
    if len(s) < 16:
        # 503, not 401: server misconfiguration, not a bad client request.
        raise HTTPException(status_code=503, detail="Auth not configured")
    return s.encode()


def _sign(kind: str, object_id: str, exp: int) -> str:
    # `kind` binds the signature to one endpoint, so a clip signature cannot be
    # replayed against a document image.
    msg = f"{kind}:{object_id}:{exp}".encode()
    return hmac.new(_secret(), msg, hashlib.sha256).hexdigest()


def mint(kind: str, object_id: str, ttl: int = MEDIA_URL_TTL_SECONDS) -> dict:
    """Return the query params that authorize `object_id` for `ttl` seconds."""
    exp = int(time.time()) + ttl
    return {"exp": exp, "sig": _sign(kind, object_id, exp)}


def verify(kind: str, object_id: str, exp: int | None, sig: str | None) -> None:
    """Raise 401/403 unless (exp, sig) authorizes `object_id`. Returns None on success."""
    if not sig or exp is None:
        raise HTTPException(status_code=401, detail="Missing signature")
    if int(exp) < int(time.time()):
        raise HTTPException(status_code=401, detail="Link expired")
    if not hmac.compare_digest(_sign(kind, object_id, int(exp)), sig):
        raise HTTPException(status_code=403, detail="Invalid signature")
```

### 2. `audio.py`

Add the import:

```python
from .. import media_links
```

Add a minting endpoint, and gate the streaming endpoint. Replace the whole
`get_clip` block with:

```python
@router.get("/clip/{clip_id}/url")
async def get_clip_url(clip_id: str, claims: dict = Depends(require_auth)):
    """Mint a short-lived signed URL for <audio src>. Authorized against the clip's
    owning session; the returned URL is what the browser actually fetches."""
    rows = query("SELECT session_id FROM answer_audio WHERE id = %s", (clip_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Clip not found")
    assert_session_access(str(rows[0]["session_id"]), claims)
    q = media_links.mint("audio_clip", clip_id)
    return {"url": f"/api/audio/clip/{clip_id}?exp={q['exp']}&sig={q['sig']}"}


# Intentionally NOT behind require_auth: this is an <audio src> target and the tag
# cannot send an Authorization header. It is instead gated by the short-lived HMAC
# minted above — see src/media_links.py.
@router.get("/clip/{clip_id}")
async def get_clip(clip_id: str, exp: int | None = None, sig: str | None = None):
    media_links.verify("audio_clip", clip_id, exp, sig)
    rows = query("SELECT object_key, mime FROM answer_audio WHERE id = %s", (clip_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Clip not found")
    data = storage.get_bytes(rows[0]["object_key"])
    if data is None:
        raise HTTPException(status_code=404, detail="Audio bytes missing")
    return StreamingResponse(io.BytesIO(data), media_type=rows[0]["mime"] or "audio/webm")
```

Also update the module docstring's `GET /api/audio/clip/{clip_id}` line to mention
the signature, and delete the stale `NOTE on auth:` comment block above
`upload_answer_audio` that says `/clip/{id}` is left open.

### 3. `ocr.py`

Add the import:

```python
from .. import media_links
```

Replace the whole `get_document_image` block with:

```python
@router.get("/documents/image/{doc_id}/url")
async def get_document_image_url(doc_id: str, claims: dict = Depends(require_auth)):
    """Mint a short-lived signed URL for <img src>. See src/media_links.py."""
    rows = query("SELECT session_id, image_key FROM session_documents WHERE id = %s", (doc_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="Document not found")
    if not rows[0]["image_key"]:
        raise HTTPException(status_code=404, detail="No image for this document")
    assert_session_access(str(rows[0]["session_id"]), claims)
    q = media_links.mint("doc_image", doc_id)
    return {"url": f"/api/ocr/documents/image/{doc_id}?exp={q['exp']}&sig={q['sig']}"}


# Intentionally NOT behind require_auth: <img src> cannot send an Authorization
# header. Gated by the short-lived HMAC minted above — see src/media_links.py.
@router.get("/documents/image/{doc_id}")
async def get_document_image(doc_id: str, exp: int | None = None, sig: str | None = None):
    media_links.verify("doc_image", doc_id, exp, sig)
    rows = query("SELECT image_key FROM session_documents WHERE id = %s", (doc_id,))
    key = rows[0]["image_key"] if rows else None
    if not key:
        raise HTTPException(status_code=404, detail="No image for this document")
    data = storage.get_bytes(key)
    if data is None:
        raise HTTPException(status_code=404, detail="Image unavailable")
    media_type = "image/png" if str(key).lower().endswith(".png") else "image/jpeg"
    return StreamingResponse(io.BytesIO(data), media_type=media_type)
```

Also update the comment in `services/python-backend/src/main.py` that currently says
`ocr → /documents/image/{id} (<img src>) stays open` / `audio → /clip/{id} (<audio src>) stays open`
to say they are gated by a signed link instead. (This is a comment-only edit to
`main.py` and is permitted for this task.)

### 4. `frontend/src/lib/api.js`

`answerAudioUrl` is currently a synchronous string builder:

```js
  answerAudioUrl: (clipId) => `${BASE}/api/audio/clip/${clipId}`,
```

Replace it, and add a document-image equivalent:

```js
  // Media URLs must now be minted (short-lived signature) because <audio>/<img>
  // cannot send an Authorization header. Both return a ready-to-use src string.
  answerAudioUrl: async (clipId) => {
    const { url } = await apiFetch(`/api/audio/clip/${clipId}/url`);
    return `${BASE}${url}`;
  },
  documentImageUrl: async (docId) => {
    const { url } = await apiFetch(`/api/ocr/documents/image/${docId}/url`);
    return `${BASE}${url}`;
  },
```

### 5. Frontend call sites

`api.answerAudioUrl(...)` is now **async**. Find its use in
`frontend/src/app/doctor/page.jsx` and resolve the URL into state before rendering,
e.g.:

```jsx
const [clipUrls, setClipUrls] = useState({});
useEffect(() => {
  let cancelled = false;
  (async () => {
    const entries = await Promise.all(
      clips.map(async (c) => [c.id, await api.answerAudioUrl(c.id).catch(() => null)])
    );
    if (!cancelled) setClipUrls(Object.fromEntries(entries.filter(([, u]) => u)));
  })();
  return () => { cancelled = true; };
}, [clips]);
```

…and render `<audio src={clipUrls[c.id]} />`, skipping clips with no URL yet.

Do the same for the document `<img>` in `frontend/src/app/his/page.jsx`, which
currently builds `/api/ocr/documents/image/<id>` by hand — search for that string.

**A minted URL expires after 5 minutes.** If a doctor leaves the page open and then
plays a clip, the `<audio>` will 401. Handle it by re-minting on the element's
`onError` handler. Do not raise the TTL to paper over this.

## Acceptance criteria

- [ ] `GET /api/audio/clip/<id>` with no query params returns `401`.
- [ ] `GET /api/ocr/documents/image/<id>` with no query params returns `401`.
- [ ] A signature minted for an audio clip, replayed against a document image of
      the same id, returns `403`.
- [ ] An expired `exp` returns `401` even with a correct `sig`.
- [ ] `GET /api/audio/clip/<id>/url` with no token returns `401`; with a patient
      token for a *different* session returns `403`.
- [ ] A doctor can still play patient answer audio in the doctor console.
- [ ] The HIS document viewer still renders the uploaded image.
- [ ] No new entry in `services/python-backend/requirements.txt`.

## How to verify

```powershell
cd services\python-backend
python -m compileall -q src
python -m pytest tests\ -q
```

With the stack up, take a real `clip_id` from the DB, then:

```powershell
$clip = docker compose exec -T postgres psql -U opd_user -d opd_preconsult -tAc "SELECT id FROM answer_audio LIMIT 1;"
$clip = $clip.Trim()

# unsigned -> 401
curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost/api/audio/clip/$clip"

# minted -> 200 (needs a doctor token in $d)
$u = (Invoke-RestMethod -Uri "http://localhost/api/audio/clip/$clip/url" -Headers @{ Authorization = "Bearer $d" }).url
curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost$u"

# tampered signature -> 403
curl.exe -s -o NUL -w "%{http_code}`n" "http://localhost$($u -replace 'sig=.','sig=0')"
```

Then in the browser: open a consulted patient in the doctor console and play an
answer clip; open the same patient in HIS and view an uploaded document.

## Done when

All four `curl.exe` status codes match, and both the doctor audio playback and the
HIS image viewer work in the browser.
