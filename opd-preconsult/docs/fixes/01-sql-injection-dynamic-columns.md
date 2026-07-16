# 01 — SQL injection via request-body object keys

**Severity:** High · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/routes/admin.js`
- `services/node-backend/src/routes/protocol.js`

Nothing else.

## The problem

Two "update" handlers build their `SET` clause by interpolating **object keys
taken straight from the request body** into SQL. Values are parameterised;
column names are not.

`services/node-backend/src/routes/admin.js`, in `router.put('/questions/:id', ...)`:

```js
    const fields = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id') continue;
      sets.push(`${k} = $${i}`);          // <-- k is attacker-controlled
      vals.push(k.includes('json') || k === 'next_rules' ? JSON.stringify(v) : v);
      i++;
    }
```

`services/node-backend/src/routes/protocol.js`, in `router.put('/:id', ...)`:

```js
    const fields = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    const jsonFields = ['trigger_conditions', 'trigger_medications', 'required_tests', 'required_vitals'];
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id' || k === 'created_at') continue;
      sets.push(`${k} = $${i}`);          // <-- k is attacker-controlled
      vals.push(jsonFields.includes(k) ? JSON.stringify(v) : v);
      i++;
    }
```

A JSON body key such as `"is_active = false, department = 'X' --"` is injected
verbatim into the statement.

Both routes are `adminOnly`, but `admin` is a single shared `ADMIN_PASSCODE`, so
this is a real authenticated SQL injection, not a theoretical one.

## Decision (already made — do not deviate)

**Whitelist the column names.** Do not attempt to escape or quote them, do not
use a query builder, do not add a dependency. Any key not on the whitelist is a
`400`, not a silent skip — a silent skip hides client bugs.

## Required change

### `admin.js`

Add this constant near the top of the file, after the existing `const adminOnly = [...]` line:

```js
// Columns a client may update on questionnaire_nodes. The UPDATE below builds its
// SET clause from request-body keys, so this list is what keeps a key like
// "is_active = false, department = 'X' --" out of the SQL. `id` and `created_at`
// are immutable. Keep in sync with db/migrations/002_questionnaires.sql.
const QUESTION_UPDATABLE = new Set([
  'department', 'text_en', 'text_hi', 'text_te', 'q_type', 'options_json',
  'required', 'triage_flag', 'triage_answer', 'next_default', 'next_rules',
  'fhir_mapping', 'is_active', 'sort_order', 'is_base',
]);
const QUESTION_JSON_COLUMNS = new Set(['options_json', 'next_rules']);
```

Then replace the loop body inside `router.put('/questions/:id', ...)` so it reads:

```js
    const fields = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id') continue;
      if (!QUESTION_UPDATABLE.has(k)) {
        return res.status(400).json({ error: `Unknown field: ${k}` });
      }
      sets.push(`${k} = $${i}`);
      vals.push(QUESTION_JSON_COLUMNS.has(k) ? JSON.stringify(v) : v);
      i++;
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
```

Note two behaviour changes that are intentional:
- the old `k.includes('json')` test is replaced by an explicit set;
- an empty body now returns `400` instead of producing `UPDATE ... SET  WHERE`.

### `protocol.js`

Add this constant after the existing `const adminOnly = [...]` line:

```js
// Columns a client may update on protocols — see the note in routes/admin.js.
// Keep in sync with db/migrations/003_protocols.sql.
const PROTOCOL_UPDATABLE = new Set([
  'name', 'department', 'trigger_conditions', 'trigger_medications',
  'required_tests', 'required_vitals', 'pre_visit_msg_en', 'pre_visit_msg_hi',
  'pre_visit_msg_te', 'authored_by', 'is_active', 'version',
]);
const PROTOCOL_JSON_COLUMNS = new Set([
  'trigger_conditions', 'trigger_medications', 'required_tests', 'required_vitals',
]);
```

Replace the loop inside `router.put('/:id', ...)`:

```js
    const fields = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id' || k === 'created_at') continue;
      if (!PROTOCOL_UPDATABLE.has(k)) {
        return res.status(400).json({ error: `Unknown field: ${k}` });
      }
      sets.push(`${k} = $${i}`);
      vals.push(PROTOCOL_JSON_COLUMNS.has(k) ? JSON.stringify(v) : v);
      i++;
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
```

Delete the now-duplicated `const jsonFields = [...]` line and the existing
`if (!sets.length)` check if it appears twice.

## Acceptance criteria

- [ ] Neither file interpolates an un-whitelisted string into SQL.
- [ ] An unknown key returns `400 {"error":"Unknown field: <key>"}`.
- [ ] An empty body returns `400 {"error":"No fields to update"}`.
- [ ] A normal edit from the HIS UI (Questions tab, Protocols tab) still works:
      every field the UI sends is on the whitelist.
- [ ] `id` (and `created_at` for protocols) are still silently skipped, **not**
      rejected — the HIS UI sends them back on save.

## How to verify

Syntax:

```powershell
cd services\node-backend
node --check src\routes\admin.js
node --check src\routes\protocol.js
```

Behavioural — with the stack up (`docker compose up -d`), log in to get an admin
token, then confirm the injection key is rejected:

```powershell
$t = (Invoke-RestMethod -Method Post -Uri http://localhost/api/admin/login `
      -ContentType 'application/json' `
      -Body '{"passcode":"<ADMIN_PASSCODE>","admin_name":"tester"}').token

# Must return 400 Unknown field, NOT 200 and NOT a 500.
curl.exe -s -o - -w "`n%{http_code}`n" -X PUT http://localhost/api/admin/questions/q_opd_base_visit_type `
  -H "Authorization: Bearer $t" -H "Content-Type: application/json" `
  --data '{"text_en = ''x'', is_active = false --":"boom"}'

# Must still return 200.
curl.exe -s -o - -w "`n%{http_code}`n" -X PUT http://localhost/api/admin/questions/q_opd_base_visit_type `
  -H "Authorization: Bearer $t" -H "Content-Type: application/json" `
  --data '{"sort_order":1}'
```

Then open the HIS dashboard (`http://localhost/his`), edit a question and a
protocol, and confirm both save without error.

## Done when

Both verification `curl.exe` calls return the stated codes, the HIS Questions and
Protocols tabs still save, and `node --check` passes on both files.
