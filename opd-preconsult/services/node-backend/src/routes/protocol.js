const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { authMiddleware, requireRole, requireSessionOwnership } = require('../middleware/auth');

const router = Router();

// Admin-only guard for protocol authoring (create/update/delete). The protocol
// LIST and GET stay open — they are department config (trigger rules, pre-visit
// messages), not patient data. `evaluate` reads a session's answers, so it needs
// a token (§5a).
const adminOnly = [authMiddleware, requireRole('admin')];

// List protocols (optionally filter by department)
router.get('/', async (req, res) => {
  try {
    const { department } = req.query;
    let result;
    if (department) {
      result = await pool.query(
        'SELECT * FROM protocols WHERE department = $1 AND is_active = true ORDER BY name',
        [department.toUpperCase()]
      );
    } else {
      result = await pool.query('SELECT * FROM protocols WHERE is_active = true ORDER BY department, name');
    }
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Get single protocol
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM protocols WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Create protocol — admin only
router.post('/', ...adminOnly, async (req, res) => {
  try {
    const { id, name, department, trigger_conditions, trigger_medications,
            required_tests, required_vitals, pre_visit_msg_en, pre_visit_msg_hi,
            pre_visit_msg_te, authored_by, version } = req.body;

    if (!id || !name || !department) {
      return res.status(400).json({ error: 'id, name, and department required' });
    }

    const result = await pool.query(
      `INSERT INTO protocols (id, name, department, trigger_conditions, trigger_medications,
        required_tests, required_vitals, pre_visit_msg_en, pre_visit_msg_hi, pre_visit_msg_te,
        authored_by, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, name, department.toUpperCase(),
       trigger_conditions ? JSON.stringify(trigger_conditions) : null,
       trigger_medications ? JSON.stringify(trigger_medications) : null,
       required_tests ? JSON.stringify(required_tests) : null,
       required_vitals ? JSON.stringify(required_vitals) : null,
       pre_visit_msg_en || null, pre_visit_msg_hi || null, pre_visit_msg_te || null,
       authored_by || null, version || '1.0']
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Protocol ID already exists' });
    sendServerError(res, err);
  }
});

// Update protocol — admin only
router.put('/:id', ...adminOnly, async (req, res) => {
  try {
    const fields = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    const jsonFields = ['trigger_conditions', 'trigger_medications', 'required_tests', 'required_vitals'];
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id' || k === 'created_at') continue;
      sets.push(`${k} = $${i}`);
      vals.push(jsonFields.includes(k) ? JSON.stringify(v) : v);
      i++;
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE protocols SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Delete (soft — set is_active = false) — admin only
router.delete('/:id', ...adminOnly, async (req, res) => {
  try {
    await pool.query('UPDATE protocols SET is_active = false WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Evaluate which protocols apply to a session — own session (patient) or any
// (clinician) (§5c).
router.get('/evaluate/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
  try {
    const sessionId = req.params.session_id;

    // Get session info
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    const dept = session.rows[0].department;

    // Get session answers. NB: the column is answer_raw (the raw answer value,
    // e.g. "yes"/"on_exertion") — what trigger_conditions compare against.
    const answers = await pool.query(
      'SELECT question_id, answer_raw FROM session_answers WHERE session_id = $1',
      [sessionId]
    );
    const answerMap = {};
    answers.rows.forEach(a => { answerMap[a.question_id] = a.answer_raw; });

    // Get active protocols for this department
    const protocols = await pool.query(
      'SELECT * FROM protocols WHERE department = $1 AND is_active = true',
      [dept]
    );

    const matched = [];
    for (const proto of protocols.rows) {
      let triggered = false;

      // Check trigger_conditions: { "question_id": "expected_answer", ... }
      if (proto.trigger_conditions) {
        const conditions = typeof proto.trigger_conditions === 'string'
          ? JSON.parse(proto.trigger_conditions)
          : proto.trigger_conditions;
        triggered = Object.entries(conditions).some(([qid, expected]) => {
          const actual = answerMap[qid];
          if (Array.isArray(expected)) return expected.includes(actual);
          return actual === expected;
        });
      }

      if (triggered) {
        matched.push({
          protocol_id: proto.id,
          name: proto.name,
          required_tests: proto.required_tests,
          required_vitals: proto.required_vitals,
          pre_visit_msg_en: proto.pre_visit_msg_en,
          pre_visit_msg_hi: proto.pre_visit_msg_hi,
          pre_visit_msg_te: proto.pre_visit_msg_te,
        });
      }
    }

    res.json({ session_id: sessionId, department: dept, matched_protocols: matched });
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
