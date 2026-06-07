const { Router } = require('express');
const pool = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

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

// Walk the DAG from its entry node, following the path determined by
// recorded answers. Stops at the first node that has no recorded answer —
// that's the "current" question — and returns the path walked so far.
//
// This is intentionally order-independent: it looks up whether *each specific
// node along the path* has an answer, rather than chronologically replaying
// session_answers by created_at. Chronological replay breaks the moment
// "Go Back" + rewind/resubmit is involved, because re-confirming an earlier
// answer re-inserts it with a fresh timestamp that can sort *after* later
// answers — scrambling the replay order and surfacing an unrelated question.
async function walkDag(session_id, department) {
  const [answeredResult, dagResult] = await Promise.all([
    pool.query('SELECT question_id, answer_raw, answer_structured FROM session_answers WHERE session_id = $1', [session_id]),
    pool.query('SELECT * FROM questionnaire_nodes WHERE department = $1 AND is_active = true ORDER BY sort_order', [department]),
  ]);
  const answeredByQuestion = Object.fromEntries(answeredResult.rows.map(a => [a.question_id, a]));
  const nodes = Object.fromEntries(dagResult.rows.map(n => [n.id, n]));
  const startNode = dagResult.rows[0];

  const path = [];
  let currentId = startNode ? startNode.id : null;
  const visited = new Set();
  while (currentId && nodes[currentId] && !visited.has(currentId)) {
    visited.add(currentId);
    const ans = answeredByQuestion[currentId];
    if (!ans) break;
    path.push({ question: nodes[currentId], answer: ans });
    currentId = resolveNext(nodes[currentId], ans.answer_raw, ans.answer_structured);
  }

  const current = (currentId && nodes[currentId] && currentId !== 'q_done') ? nodes[currentId] : null;
  return { path, current, total: dagResult.rows.length - 1 };
}

// Get next question for a session
router.get('/next/:session_id', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.params;

    const sessResult = await pool.query('SELECT department FROM sessions WHERE id = $1', [session_id]);
    if (!sessResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const department = sessResult.rows[0].department;

    const { path, current, total } = await walkDag(session_id, department);

    if (!current) {
      return res.json({ done: true, question: null });
    }

    res.json({
      done: false,
      question: current,
      progress: { answered: path.length, total }
    });
  } catch (err) {
    console.error('next question error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get the ordered list of previously-answered questions along the DAG path
// actually taken — used by the client to rebuild its "Go Back" history stack
// on mount (e.g. after returning from the documents/vitals pages).
router.get('/history/:session_id', authMiddleware, async (req, res) => {
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

// Get all answers for a session
router.get('/answers/:session_id', async (req, res) => {
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
