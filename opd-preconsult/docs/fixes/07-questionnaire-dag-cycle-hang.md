# 07 — A cycle in the question DAG hangs the interview forever

**Severity:** Medium · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/routes/questionnaire.js`

Nothing else.

## The problem

In `walkDag()`, phase 2 walks the department-specific DAG:

```js
  // ── Phase 2: department DAG ──
  let currentId = dagNodes.length ? dagNodes[0].id : null;
  const visited = new Set();
  while (currentId && nodes[currentId] && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodes[currentId];
    if (node.q_type === 'TERMINAL') { currentId = null; break; }
    const ans = answeredByQuestion[currentId];
    if (!ans) break;
    path.push({ question: node, answer: ans });
    currentId = resolveNext(node, ans.answer_raw, ans.answer_structured);
  }

  const totalBase = baseNodes.filter(b => roleOf(b) !== 'visit_type' && (roleOf(b) !== 'progress' || isFollowup)).length;
  const current = (currentId && nodes[currentId] && nodes[currentId].q_type !== 'TERMINAL') ? nodes[currentId] : null;
  return { path, current, total: totalBase + dagNodes.length };
```

The `!visited.has(currentId)` loop guard prevents an infinite loop, but look at what
happens when it fires. The loop exits with `currentId` still pointing at the
**already-visited, already-answered** node. `current` is then set to that node.

So `GET /api/q/next/:session_id` returns a question the patient already answered.
They answer it again, the walk returns to the same place, and `walk.current` never
becomes `null`. The interview can never reach `{ done: true }`. The patient is stuck
in a loop they cannot exit.

DAG edges (`next_default`, `next_rules[].go_to`) are authored by admins through the
HIS Questions tab, so a cycle is reachable without any code change — a mistyped
`go_to` is enough.

## Decisions (already made — do not deviate)

1. **Treat a revisit as terminal at runtime.** When the walk reaches a node it has
   already visited, stop and report the interview as complete rather than re-asking.
   Finishing the interview with a truncated path is strictly better than trapping the
   patient — the doctor still sees every answer that was recorded.
2. **Log a warning** naming the department and the node, so the bad DAG is findable.
3. **Do not** add cycle validation to the admin question-save endpoint in this task.
   That is a separate, larger change (it needs the full node set to validate against).
   Runtime safety first.
4. Do not change phase 1 (the linear base questions). It cannot cycle.
5. Do not change the `total` calculation. It is already an overestimate (it counts
   every DAG node, not just the path taken); that is a cosmetic progress-bar issue
   and out of scope.

## Required change

Replace the phase-2 block in `walkDag()` with:

```js
  // ── Phase 2: department DAG ──
  let currentId = dagNodes.length ? dagNodes[0].id : null;
  const visited = new Set();
  while (currentId && nodes[currentId]) {
    // A cycle in the authored DAG (a next_default / go_to pointing back at a node
    // we already walked). Treat the revisit as terminal: returning the node as
    // `current` would re-ask a question the patient already answered, and the walk
    // would never yield done:true — trapping them in the interview.
    if (visited.has(currentId)) {
      console.warn(`[questionnaire] cycle in ${department} DAG at node '${currentId}' — ending interview here. Fix the question's next_default / next_rules in HIS.`);
      currentId = null;
      break;
    }
    visited.add(currentId);
    const node = nodes[currentId];
    if (node.q_type === 'TERMINAL') { currentId = null; break; }
    const ans = answeredByQuestion[currentId];
    if (!ans) break;
    path.push({ question: node, answer: ans });
    currentId = resolveNext(node, ans.answer_raw, ans.answer_structured);
  }
```

Note the two changes:
- `!visited.has(currentId)` is removed from the `while` condition;
- the check moved **inside** the loop, where it can null out `currentId`.

The `const current = ...` line below is unchanged and now correctly yields `null`.

`walkDag` already receives `department` as a parameter, so the log line compiles as-is.

## Acceptance criteria

- [ ] The `while` condition no longer contains `!visited.has(...)`.
- [ ] Reaching an already-visited node sets `currentId = null` and breaks.
- [ ] A warning is logged naming the department and node id.
- [ ] With a cyclic DAG, `GET /api/q/next/:session_id` returns `{ done: true, question: null }`
      instead of re-serving an answered question.
- [ ] A normal, acyclic DAG interview is unaffected end to end.
- [ ] `GET /api/q/history/:session_id` (which also calls `walkDag`) still returns the
      answered path.

## How to verify

```powershell
cd services\node-backend
node --check src\routes\questionnaire.js
```

Build a cycle deliberately. With the stack up, take two DAG nodes in `OPD` and point
them at each other:

```powershell
docker compose exec postgres psql -U opd_user -d opd_preconsult -c @"
SELECT id, next_default FROM questionnaire_nodes
 WHERE department='OPD' AND is_base = false ORDER BY sort_order LIMIT 2;
"@
```

Take the two ids (call them `A` and `B`) and:

```powershell
docker compose exec postgres psql -U opd_user -d opd_preconsult -c `
  "UPDATE questionnaire_nodes SET next_default='<B>' WHERE id='<A>'; UPDATE questionnaire_nodes SET next_default='<A>' WHERE id='<B>';"
```

Now run a patient session through the browser answering `A` and `B`. Before the fix
the interview re-asks `A` forever. After the fix:

```powershell
# with the patient token in $p and their session id in $s
Invoke-RestMethod -Uri "http://localhost/api/q/next/$s" -Headers @{ Authorization = "Bearer $p" }
# expect: done = True, question = (null)

docker compose logs node-backend | Select-String "cycle in OPD DAG"
# expect the warning
```

**Restore the DAG afterwards** — set `next_default` on `A` and `B` back to what the
first query showed, or re-seed by truncating `questionnaire_nodes` and restarting
node-backend.

## Done when

The cyclic DAG produces `done: true` plus the warning, and a clean acyclic interview
still completes normally through the browser.
