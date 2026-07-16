# 15 — Waiting-room board shows abandoned locks forever

**Severity:** Low · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/routes/queue.js`

Nothing else.

## The problem

`GET /api/queue/board` powers the public "Now Serving" display in the waiting area. It
runs two queries. The `waiting` one is bounded to the last 24 hours:

```js
    const waiting = await pool.query(
      `SELECT token_label, triage_level
         FROM sessions
        WHERE department = $1
          AND state = 'COMPLETE'
          AND consulted_at IS NULL
          AND dispatched_at IS NULL
          AND removed_at IS NULL
          AND token_label IS NOT NULL
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY ...`,
      [department]
    );
```

The `now_serving` one is not:

```js
    const nowServing = await pool.query(
      `SELECT token_label, triage_level
         FROM sessions
        WHERE department = $1
          AND assigned_doctor_id IS NOT NULL
          AND consulted_at IS NOT NULL
          AND dispatched_at IS NULL
          AND removed_at IS NULL
          AND token_label IS NOT NULL
        ORDER BY consulted_at ASC`,
      [department]
    );
```

A visit that a doctor opened (`consulted_at` set) but never finished (`dispatched_at`
still null) and never released matches forever. It happens whenever a doctor closes the
browser mid-consultation, or the pilot day ends with a patient still open.

Result: the waiting-room screen shows a token from three days ago as "Now Serving",
permanently, above the real queue. Patients read that screen to know whether to approach
the door.

Note the ordering asymmetry too: `ORDER BY consulted_at ASC` puts the *oldest* stuck lock
first, so the stale token is the most prominent thing on the board.

## Decisions (already made — do not deviate)

1. **Bound `now_serving` to the same 24-hour service window** the `waiting` query already
   uses. Filter on `consulted_at`, not `created_at` — the question is "was this patient
   picked up recently", not "did they arrive recently". A patient who arrived yesterday
   evening and is being seen this morning must still show.
2. **Do not** auto-release stale locks (i.e. do not `UPDATE sessions SET consulted_at =
   NULL`). A background reaper that mutates clinical state is a much bigger decision than
   a display filter, and it would silently drop a patient a doctor genuinely has open.
   The doctor console already has an explicit Release action.
3. **Do not** change the `ORDER BY`. Oldest-first is correct for a "now serving" list —
   the patient who has been in the room longest is the one being seen.
4. Leave `GET /api/queue/last` alone. It reads `queue_counters`, which already has a
   `service_date` filter.
5. The board stays unauthenticated and PHI-free (token numbers only). Do not add auth.

## Required change

In `router.get('/board', ...)`, add one condition to the `nowServing` query:

```js
    const nowServing = await pool.query(
      `SELECT token_label, triage_level
         FROM sessions
        WHERE department = $1
          AND assigned_doctor_id IS NOT NULL
          AND consulted_at IS NOT NULL
          AND dispatched_at IS NULL
          AND removed_at IS NULL
          AND token_label IS NOT NULL
          -- Same 24h service window the 'waiting' query below uses. A visit a doctor
          -- opened but never dispatched or released (browser closed mid-consult, end of
          -- the pilot day) otherwise matches forever and pins a days-old token to the
          -- top of the public board. Filter on consulted_at, not created_at: a patient
          -- who arrived yesterday evening and is seen this morning must still show.
          AND consulted_at > NOW() - INTERVAL '24 hours'
        ORDER BY consulted_at ASC`,
      [department]
    );
```

That is the entire change.

## Acceptance criteria

- [ ] `now_serving` excludes sessions whose `consulted_at` is older than 24 hours.
- [ ] A session consulted 1 hour ago still appears, even if `created_at` is 20 hours old.
- [ ] The `waiting` query is unchanged.
- [ ] `ORDER BY consulted_at ASC` is unchanged.
- [ ] The endpoint remains unauthenticated and returns only `token_label` and
      `triage_level` — no names, no phones.
- [ ] `GET /api/queue/last` is untouched.

## How to verify

```powershell
cd services\node-backend
node --check src\routes\queue.js
```

With the stack up, take a session that has a `token_label` in department `OPD` and
manufacture a stale lock:

```powershell
$s = docker compose exec -T postgres psql -U opd_user -d opd_preconsult -tAc `
  "SELECT id FROM sessions WHERE department='OPD' AND token_label IS NOT NULL LIMIT 1;"
$s = $s.Trim()

# stale lock: opened 3 days ago, never dispatched
docker compose exec postgres psql -U opd_user -d opd_preconsult -c @"
UPDATE sessions
   SET assigned_doctor_id = (SELECT id FROM doctors LIMIT 1),
       consulted_at = NOW() - interval '3 days',
       dispatched_at = NULL, removed_at = NULL
 WHERE id = '$s';
"@

(Invoke-RestMethod -Uri "http://localhost/api/queue/board?department=OPD").now_serving
# expect: EMPTY — the 3-day-old token must not appear
```

Now prove a genuinely current consultation still shows, and that an old *arrival* is not
excluded:

```powershell
docker compose exec postgres psql -U opd_user -d opd_preconsult -c @"
UPDATE sessions
   SET created_at   = NOW() - interval '20 hours',
       consulted_at = NOW() - interval '1 hour'
 WHERE id = '$s';
"@

(Invoke-RestMethod -Uri "http://localhost/api/queue/board?department=OPD").now_serving
# expect: one row, with this session's token_label
```

Confirm no PHI leaked:

```powershell
Invoke-RestMethod -Uri "http://localhost/api/queue/board?department=OPD" | ConvertTo-Json -Depth 4
# expect only department / now_serving / waiting / waiting_count / updated_at,
# and each row only token_label + triage_level
```

Reset the session afterwards (`consulted_at = NULL, assigned_doctor_id = NULL`) or
re-run your normal seed.

## Done when

The 3-day-old lock is absent from `now_serving`, the 1-hour-old consultation with a
20-hour-old arrival is present, and the response still contains no patient identifiers.
