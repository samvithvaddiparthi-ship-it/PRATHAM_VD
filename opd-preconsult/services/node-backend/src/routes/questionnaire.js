const { Router } = require('express');
const pool = require('../models/db');
const { authMiddleware, requireSessionOwnership } = require('../middleware/auth');

const router = Router();

// Get the full schema for a department
router.get('/schema/:department', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM questionnaire_nodes WHERE department = $1 AND is_active = true ORDER BY sort_order',
      [req.params.department.toUpperCase()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('schema error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The logical role of a base question, derived from its id suffix after
// `_base_` (e.g. q_card_base_visit_type -> "visit_type"). Lets the conditional
// flow (auto visit-type, progress-only-for-returning) survive text edits in HIS.
function roleOf(node) {
  if (!node || !node.is_base) return null;
  const i = node.id.indexOf('_base_');
  return i >= 0 ? node.id.slice(i + 6) : null;
}

// Walk the interview in two phases and return the path taken plus the current
// (first unanswered) question. Intentionally order-independent — it checks
// whether *each specific node* has an answer rather than replaying answers by
// timestamp, so "Go Back" + rewind/resubmit can never scramble the order.
//
//   Phase 1 — BASE: the shared intake questions (is_base), walked LINEARLY by
//     sort_order. `visit_type` is hidden/auto; `progress` is skipped entirely
//     unless this is a follow-up. This is the "simple line" with direct go-back.
//   Phase 2 — DAG: the department-specific questions (non-base), walked by
//     next_default / next_rules from the lowest-sort_order entry node.
async function walkDag(session_id, department) {
  const [answeredResult, nodesResult] = await Promise.all([
    pool.query('SELECT question_id, answer_raw, answer_structured FROM session_answers WHERE session_id = $1', [session_id]),
    pool.query('SELECT * FROM questionnaire_nodes WHERE department = $1 AND is_active = true ORDER BY sort_order', [department]),
  ]);
  const answeredByQuestion = Object.fromEntries(answeredResult.rows.map(a => [a.question_id, a]));
  const nodes = Object.fromEntries(nodesResult.rows.map(n => [n.id, n]));

  const baseNodes = nodesResult.rows.filter(n => n.is_base);
  const dagNodes = nodesResult.rows.filter(n => !n.is_base && n.q_type !== 'TERMINAL');

  // Is this a follow-up? Decided by the (auto-resolved) visit_type answer.
  const visitNode = baseNodes.find(n => roleOf(n) === 'visit_type');
  const visitAns = visitNode ? answeredByQuestion[visitNode.id]?.answer_raw : null;
  const isFollowup = visitAns === 'followup';

  const path = [];

  // ── Phase 1: base (linear) ──
  for (const node of baseNodes) {
    if (roleOf(node) === 'progress' && !isFollowup) continue; // only for returning patients
    const ans = answeredByQuestion[node.id];
    if (!ans) {
      const totalBase = baseNodes.filter(b => roleOf(b) !== 'visit_type' && (roleOf(b) !== 'progress' || isFollowup)).length;
      return { path, current: node, total: totalBase + dagNodes.length };
    }
    path.push({ question: node, answer: ans });
  }

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
}

// Get next question for a session
router.get('/next/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
  try {
    const { session_id } = req.params;

    const sessResult = await pool.query('SELECT department, patient_phone, patient_name FROM sessions WHERE id = $1', [session_id]);
    if (!sessResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const { department, patient_phone, patient_name } = sessResult.rows[0];

    let walk = await walkDag(session_id, department);

    // The "first visit or follow-up?" question (base, role=visit_type) is never
    // shown to the patient — we resolve it automatically and authoritatively from
    // their history: if THIS person (phone + name — one number may serve a whole
    // family) has ANY prior COMPLETED visit it's a follow-up, otherwise a first
    // visit. Determining it here (server-side, from live data) rather than from a
    // client flag avoids stale/cross-patient classification.
    if (walk.current && roleOf(walk.current) === 'visit_type') {
      const prior = await pool.query(
        `SELECT 1 FROM sessions
          WHERE patient_phone = $1 AND lower(trim(patient_name)) = lower(trim($3))
            AND id <> $2 AND state = 'COMPLETE' LIMIT 1`,
        [patient_phone, session_id, patient_name || '']
      );
      const answer = prior.rows.length ? 'followup' : 'first';
      await pool.query(
        `INSERT INTO session_answers (session_id, question_id, answer_raw, answer_structured, input_mode)
         VALUES ($1, $2, $3, $4, 'auto')
         ON CONFLICT DO NOTHING`,
        [session_id, walk.current.id, answer, JSON.stringify({ value: answer })]
      );
      walk = await walkDag(session_id, department);
    }

    if (!walk.current) {
      return res.json({ done: true, question: null });
    }

    res.json({
      done: false,
      question: walk.current,
      progress: { answered: walk.path.length, total: walk.total }
    });
  } catch (err) {
    console.error('next question error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get the ordered list of previously-answered questions along the DAG path
// actually taken — used by the client to rebuild its "Go Back" history stack
// on mount (e.g. after returning from the documents/vitals pages).
router.get('/history/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
  try {
    const { session_id } = req.params;

    const sessResult = await pool.query('SELECT department FROM sessions WHERE id = $1', [session_id]);
    if (!sessResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const department = sessResult.rows[0].department;

    const { path } = await walkDag(session_id, department);
    res.json({
      history: path.map(({ question, answer }) => ({ question, answer_raw: answer.answer_raw }))
    });
  } catch (err) {
    console.error('history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit an answer
router.post('/answer', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const { question_id, answer_raw, answer_structured, input_mode } = req.body;

    if (!question_id || answer_raw === undefined) {
      return res.status(400).json({ error: 'question_id and answer_raw required' });
    }

    // Store answer
    await pool.query(
      `INSERT INTO session_answers (session_id, question_id, answer_raw, answer_structured, input_mode)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [session_id, question_id, answer_raw, answer_structured ? JSON.stringify(answer_structured) : null, input_mode || 'text']
    );

    // Check triage flags on this question
    const nodeResult = await pool.query('SELECT * FROM questionnaire_nodes WHERE id = $1', [question_id]);
    let triage_flag = null;
    if (nodeResult.rows.length) {
      const node = nodeResult.rows[0];
      if (node.triage_flag && node.triage_answer) {
        const answerVal = (answer_structured?.value || answer_raw || '').toString().toLowerCase();
        if (answerVal === node.triage_answer.toLowerCase()) {
          triage_flag = node.triage_flag;
          // Update session triage if escalating
          await pool.query(
            `UPDATE sessions SET triage_level = CASE
              WHEN triage_level = 'RED' THEN 'RED'
              WHEN $1 = 'RED' THEN 'RED'
              WHEN triage_level = 'AMBER' THEN 'AMBER'
              ELSE $1 END,
            updated_at = NOW() WHERE id = $2`,
            [triage_flag, session_id]
          );
        }
      }
    }

    // Update session state to INTERVIEW if not already
    await pool.query(
      `UPDATE sessions SET state = CASE WHEN state IN ('CONSENTED', 'INIT', 'REGISTERED') THEN 'INTERVIEW' ELSE state END, updated_at = NOW() WHERE id = $1`,
      [session_id]
    );

    res.json({ stored: true, triage_flag });
  } catch (err) {
    console.error('answer error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Rewind: forget the recorded answer for question_id, so the DAG resume walk
// stops there and re-asks it instead of skipping past it. No cascade needed —
// the structural walk in walkDag() simply stops at the first unanswered node
// it reaches, so any "downstream" answers left behind are inert until that
// node (and the path through it) is reached again.
router.post('/rewind', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const { question_id } = req.body;
    if (!question_id) return res.status(400).json({ error: 'question_id required' });

    await pool.query(
      'DELETE FROM session_answers WHERE session_id = $1 AND question_id = $2',
      [session_id, question_id]
    );
    res.json({ rewound: true });
  } catch (err) {
    console.error('rewind error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all answers for a session (free-text symptom PHI) — own session (patient)
// or any (clinician) (§5c).
router.get('/answers/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM session_answers WHERE session_id = $1 ORDER BY created_at',
      [req.params.session_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('get answers error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function resolveNext(node, answerRaw, answerStructured) {
  const answerVal = (answerStructured?.value || answerRaw || '').toString().toLowerCase();

  // Check conditional rules first
  if (node.next_rules && Array.isArray(node.next_rules)) {
    for (const rule of node.next_rules) {
      if (rule.if_answer && rule.if_answer.toLowerCase() === answerVal && rule.go_to) {
        return rule.go_to;
      }
    }
  }

  return node.next_default || null;
}

module.exports = router;
