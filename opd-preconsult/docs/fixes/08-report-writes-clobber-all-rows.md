# 08 — Feedback and SOAP writes overwrite every report row for a session

**Severity:** Medium · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/python-backend/src/routers/report.py`
- `services/python-backend/src/routers/scribe.py`

Nothing else.

## The problem

A session can legitimately have **more than one** row in `session_reports`. The report
is regenerated when late vitals arrive, appending a new row. This is documented in
`services/node-backend/src/routes/doctor.js`:

```js
    // A session can have MORE THAN ONE row in session_reports (e.g. the report
    // was regenerated after late vitals). A plain LEFT JOIN would then emit one
    // consulted row per report → duplicate cards. DISTINCT ON (s.id) collapses
    // each session to a single row, keeping its LATEST report.
```

But three write paths target **every** row for the session, silently rewriting
historical reports.

`services/python-backend/src/routers/report.py`:

```python
    execute(
        "UPDATE session_reports SET doctor_feedback = %s WHERE session_id = %s",
        (val, session_id),
    )
```

`services/python-backend/src/routers/scribe.py`, in `extract_soap`:

```python
            execute(
                """UPDATE session_reports SET scribe_transcript = %s, scribe_soap = %s, scribe_created_at = NOW()
                   WHERE session_id = %s""",
                (transcript, json.dumps(soap_json), session_id),
            )
```

and in `save_soap`:

```python
        execute(
            """UPDATE session_reports SET scribe_soap = %s, scribe_created_at = NOW()
               WHERE session_id = %s""",
            (json.dumps({"text": soap_text}), session_id),
        )
```

Meanwhile `edit_report` in the same file already does it correctly — it resolves the
latest row's `id` first, then updates by `id`. Copy that pattern.

Reads are already correct: `get_report` and `get_soap` both use
`ORDER BY created_at DESC LIMIT 1`.

## Decisions (already made — do not deviate)

1. **Always target the latest report row by `id`**, resolved with
   `ORDER BY created_at DESC LIMIT 1`, exactly as `edit_report` does today.
2. **Return `404` when no report row exists.** `submit_feedback` and `extract_soap`
   currently update zero rows and report success, which hides a real failure.
   `save_soap` already raises on DB error but not on "no such report".
3. Do **not** add a `latest` boolean column or a unique constraint on `session_id`.
   Multiple rows per session is the intended design.
4. Do **not** change `get_report` / `get_soap` — their reads are already correct.

## Required change

### 1. `report.py` — `submit_feedback`

Replace the whole function body:

```python
@router.post("/{session_id}/feedback", dependencies=clinical_only)
async def submit_feedback(session_id: str, feedback: dict):
    val = feedback.get("feedback")
    if val not in ("accurate", "inaccurate"):
        raise HTTPException(status_code=400, detail="Feedback must be 'accurate' or 'inaccurate'")
    # A session can hold several report rows (regenerated after late vitals). Target
    # only the LATEST — a bare WHERE session_id rewrote the historical ones too.
    rows = query(
        "SELECT id FROM session_reports WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Report not found")
    execute(
        "UPDATE session_reports SET doctor_feedback = %s WHERE id = %s",
        (val, rows[0]["id"]),
    )
    return {"stored": True}
```

### 2. `scribe.py` — imports and a shared helper

`scribe.py` already imports `query` and `execute` from `..db`. Add this helper just
below the `PROMPT_DIR` line:

```python
def _latest_report_id(session_id: str):
    """The id of the session's most recent session_reports row, or None.

    A session can hold several report rows (the report is regenerated when late
    vitals arrive). Scribe writes must target the latest one — a bare
    `WHERE session_id = ...` silently rewrote every historical report.
    """
    rows = query(
        "SELECT id FROM session_reports WHERE session_id = %s ORDER BY created_at DESC LIMIT 1",
        (session_id,),
    )
    return rows[0]["id"] if rows else None
```

### 3. `scribe.py` — `extract_soap`

Replace:

```python
    # Store in DB if session_id provided
    if session_id:
        try:
            execute(
                """UPDATE session_reports SET scribe_transcript = %s, scribe_soap = %s, scribe_created_at = NOW()
                   WHERE session_id = %s""",
                (transcript, json.dumps(soap_json), session_id),
            )
        except Exception as e:
            print(f"[scribe] DB store error: {e}", flush=True)
```

with:

```python
    # Store in DB if session_id provided
    if session_id:
        try:
            report_id = _latest_report_id(session_id)
            if report_id is None:
                print(f"[scribe] no report row for session {session_id} — SOAP not stored", flush=True)
            else:
                execute(
                    """UPDATE session_reports SET scribe_transcript = %s, scribe_soap = %s, scribe_created_at = NOW()
                       WHERE id = %s""",
                    (transcript, json.dumps(soap_json), report_id),
                )
        except Exception as e:
            print(f"[scribe] DB store error: {e}", flush=True)
```

Note this write stays best-effort (the SOAP is still returned to the caller either
way) — that is existing, intended behaviour. Do not make it raise.

### 4. `scribe.py` — `save_soap`

This one **is** an explicit save action, so it must fail loudly. Replace:

```python
@router.post("/soap/{session_id}")
async def save_soap(session_id: str, body: dict):
    """Persist the doctor's edited SOAP note (free text). Stored in the existing
    scribe_soap column as {"text": ...} so it round-trips through get_soap."""
    soap_text = (body.get("soap_text") or "").strip()
    try:
        execute(
            """UPDATE session_reports SET scribe_soap = %s, scribe_created_at = NOW()
               WHERE session_id = %s""",
            (json.dumps({"text": soap_text}), session_id),
        )
    except Exception as e:
        print(f"[scribe] save_soap error: {e}", flush=True)
        raise HTTPException(status_code=500, detail="Could not save SOAP note")
    return {"saved": True}
```

with:

```python
@router.post("/soap/{session_id}")
async def save_soap(session_id: str, body: dict):
    """Persist the doctor's edited SOAP note (free text). Stored in the existing
    scribe_soap column as {"text": ...} so it round-trips through get_soap."""
    soap_text = (body.get("soap_text") or "").strip()
    report_id = _latest_report_id(session_id)
    if report_id is None:
        raise HTTPException(status_code=404, detail="Report not found")
    try:
        execute(
            """UPDATE session_reports SET scribe_soap = %s, scribe_created_at = NOW()
               WHERE id = %s""",
            (json.dumps({"text": soap_text}), report_id),
        )
    except Exception as e:
        print(f"[scribe] save_soap error: {e}", flush=True)
        raise HTTPException(status_code=500, detail="Could not save SOAP note")
    return {"saved": True}
```

## Acceptance criteria

- [ ] No `UPDATE session_reports ... WHERE session_id = %s` remains in either file.
      (`edit_report` already uses `WHERE id = %s` — leave it.)
- [ ] `submit_feedback` returns `404` when the session has no report.
- [ ] `save_soap` returns `404` when the session has no report.
- [ ] `extract_soap` logs and skips when there is no report row, and still returns
      the SOAP object to the caller.
- [ ] Given a session with **two** report rows, submitting feedback changes only the
      newer row's `doctor_feedback`.
- [ ] Given a session with two report rows, saving a SOAP note changes only the
      newer row's `scribe_soap`.

## How to verify

```powershell
cd services\python-backend
python -m compileall -q src
python -m pytest tests\ -q
Select-String -Path src\routers\report.py, src\routers\scribe.py -Pattern 'UPDATE session_reports.*WHERE session_id'
# must produce no matches
```

Multi-row behaviour — with the stack up, pick a session that has a report and force a
second row:

```powershell
$s = "<session uuid with a report>"
docker compose exec postgres psql -U opd_user -d opd_preconsult -c @"
INSERT INTO session_reports (session_id, report_md, created_at)
VALUES ('$s', 'NEWER REPORT', NOW() + interval '1 minute');
"@

# doctor token in $d
Invoke-RestMethod -Method Post -Uri "http://localhost/api/report/$s/feedback" `
  -Headers @{ Authorization = "Bearer $d" } -ContentType 'application/json' `
  -Body '{"feedback":"accurate"}'

docker compose exec postgres psql -U opd_user -d opd_preconsult -c @"
SELECT left(report_md, 12) AS report, doctor_feedback
  FROM session_reports WHERE session_id = '$s' ORDER BY created_at;
"@
# expect: the OLDER row's doctor_feedback is still NULL,
#         only 'NEWER REPORT' has doctor_feedback = 'accurate'
```

404 path:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST "http://localhost/api/report/00000000-0000-0000-0000-000000000000/feedback" `
  -H "Authorization: Bearer $d" -H "Content-Type: application/json" --data '{"feedback":"accurate"}'
# expect 404
```

Delete the injected `NEWER REPORT` row afterwards.

## Done when

`Select-String` finds no `WHERE session_id` update, the two-row test shows only the
newer row changed, and the 404 path returns `404`.
