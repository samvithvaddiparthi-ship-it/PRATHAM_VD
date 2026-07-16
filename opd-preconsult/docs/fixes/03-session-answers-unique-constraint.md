# 03 — `ON CONFLICT DO NOTHING` is dead: no unique constraint exists

**Severity:** High · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `db/migrations/027_session_answers_unique.sql` (new file)
- `services/node-backend/src/routes/questionnaire.js`
- `services/node-backend/src/routes/whatsapp.js`

Nothing else.

## The problem

Three inserts rely on a conflict that can never happen.

`db/migrations/001_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS session_answers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID REFERENCES sessions(id),
  question_id   VARCHAR(128) NOT NULL,
  answer_raw    TEXT,
  answer_structured JSONB,
  input_mode    VARCHAR(8) DEFAULT 'text',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

The only unique index is on `id`, which is a fresh `gen_random_uuid()` on every
insert. So in `questionnaire.js`:

```js
    await pool.query(
      `INSERT INTO session_answers (session_id, question_id, answer_raw, answer_structured, input_mode)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
```

…the `ON CONFLICT DO NOTHING` is a no-op. Answering the same question twice (a
double-tapped Submit, a retried request) inserts **two rows**.

Consequences observed downstream:
- `GET /api/q/answers/:session_id` returns duplicates.
- `services/python-backend/src/routers/report.py` feeds duplicated Q&A pairs to the
  LLM and emits duplicate FHIR `Condition` resources from `_build_fhir_bundle`.
- `whatsapp.js` `getNextQuestion()` replays answers in `created_at` order to walk
  the DAG; duplicates make it walk wrong.

(`walkDag` in `questionnaire.js` happens to tolerate duplicates because it builds
an `Object.fromEntries` map. That is luck, not design.)

## Decisions (already made — do not deviate)

1. The natural key is `(session_id, question_id)`.
2. Existing duplicates must be removed **before** the unique index is created, in
   the same migration. **Keep the most recent row** (highest `created_at`), because
   the newest answer is the one the patient meant.
3. Keep `DO NOTHING` semantics — do **not** change these to `DO UPDATE`. A re-answer
   is expressed by `POST /api/q/rewind` (which deletes the row) followed by a fresh
   insert. Turning these into upserts would let a stale retry silently overwrite a
   corrected answer.
4. Use a `CREATE UNIQUE INDEX`, not an `ALTER TABLE ... ADD CONSTRAINT`. The index
   form supports `IF NOT EXISTS`, which the migration runner requires (every
   migration must be re-runnable).

## Required change

### 1. New migration `db/migrations/027_session_answers_unique.sql`

```sql
-- A session answers each question at most once. Three INSERTs (questionnaire.js x2,
-- whatsapp.js x1) already say ON CONFLICT DO NOTHING, but no unique constraint ever
-- existed, so the clause was dead and double-submits inserted duplicate rows.
--
-- Step 1: collapse existing duplicates, keeping the most recent answer per
-- (session_id, question_id). ctid breaks ties when created_at is identical.
DELETE FROM session_answers a
      USING session_answers b
      WHERE a.session_id  = b.session_id
        AND a.question_id = b.question_id
        AND (a.created_at < b.created_at
             OR (a.created_at = b.created_at AND a.ctid < b.ctid));

-- Step 2: make it impossible to recreate them. Index (not constraint) so this
-- migration is idempotent and safe to re-run, per db/migrations conventions.
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_answers_session_question
    ON session_answers (session_id, question_id);
```

### 2. `questionnaire.js` — two inserts need a conflict target

`ON CONFLICT DO NOTHING` with no target works against *any* unique index, so it
would technically start functioning now. Name the target anyway so the intent is
explicit and a future index cannot silently change the behaviour.

In `router.get('/next/:session_id', ...)`, the auto visit-type insert:

```js
      await pool.query(
        `INSERT INTO session_answers (session_id, question_id, answer_raw, answer_structured, input_mode)
         VALUES ($1, $2, $3, $4, 'auto')
         ON CONFLICT (session_id, question_id) DO NOTHING`,
        [session_id, walk.current.id, answer, JSON.stringify({ value: answer })]
      );
```

In `router.post('/answer', ...)`:

```js
    await pool.query(
      `INSERT INTO session_answers (session_id, question_id, answer_raw, answer_structured, input_mode)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, question_id) DO NOTHING`,
      [session_id, question_id, answer_raw, answer_structured ? JSON.stringify(answer_structured) : null, input_mode || 'text']
    );
```

### 3. `whatsapp.js` — one insert

In `answerQuestion(...)`:

```js
  await pool.query(
    `INSERT INTO session_answers (session_id, question_id, answer_raw, input_mode)
     VALUES ($1, $2, $3, 'whatsapp') ON CONFLICT (session_id, question_id) DO NOTHING`,
    [conv.session_id, nextQ.id, answerRaw]
  );
```

## Gotcha you must not trip over

`session_answers.session_id` is **nullable**. In Postgres a unique index treats
`NULL` values as distinct, so rows with `session_id IS NULL` will not conflict with
each other. That is fine — no code path inserts a null `session_id`, and tightening
the column to `NOT NULL` is out of scope for this task. **Do not add `NOT NULL`.**

## Acceptance criteria

- [ ] `db/migrations/027_session_answers_unique.sql` exists and is idempotent
      (running it twice against the same DB succeeds).
- [ ] The migration deletes duplicates before creating the index (otherwise index
      creation fails on any DB that already has duplicate rows).
- [ ] All three `ON CONFLICT` clauses name `(session_id, question_id)`.
- [ ] Submitting the same `question_id` twice for one session leaves exactly one row.
- [ ] `POST /api/q/rewind` followed by a new answer still records the new answer
      (the rewind deletes the row first, so the insert does not conflict).
- [ ] node-backend starts cleanly and logs `[migrate] applied 027_session_answers_unique.sql`.

## How to verify

```powershell
docker compose up -d --build
docker compose logs node-backend | Select-String "027_session_answers_unique"
```

Idempotency (re-running the SQL by hand must not error):

```powershell
docker compose exec -T postgres psql -U opd_user -d opd_preconsult -f - < db\migrations\027_session_answers_unique.sql
```

Duplicate rejection:

```powershell
docker compose exec postgres psql -U opd_user -d opd_preconsult -c @"
SELECT session_id, question_id, COUNT(*)
  FROM session_answers
 GROUP BY 1,2 HAVING COUNT(*) > 1;
"@
# must return 0 rows
```

Then walk a patient through the interview in the browser, double-tapping Submit on
one question, and re-run the duplicate query — still 0 rows. Confirm the doctor's
report for that session lists each question once.

## Done when

The duplicate query returns zero rows, the migration re-runs cleanly, and a
rewind-then-reanswer still records the corrected answer.
