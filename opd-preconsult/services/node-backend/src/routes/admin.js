const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { baseNodesForDept } = require('../seed/baseTemplate');

const router = Router();

// ── Departments ──

// List departments
router.get('/departments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet — return hardcoded defaults
    res.json([
      { code: 'CARD', name: 'Cardiology', is_active: true },
      { code: 'GEN', name: 'General Medicine', is_active: true },
    ]);
  }
});

// Create department
router.post('/departments', async (req, res) => {
  try {
    const { code, name } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const cleanCode = code.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (cleanCode.length < 2) return res.status(400).json({ error: 'Code must be at least 2 characters (letters/numbers only)' });

    const result = await pool.query(
      'INSERT INTO departments (code, name) VALUES ($1, $2) RETURNING *',
      [cleanCode, name]
    );

    // Seed the shared base intake questions for the new department so it starts
    // with the common template; DAG questions are added on top in HIS.
    for (const node of baseNodesForDept(cleanCode)) {
      await pool.query(
        `INSERT INTO questionnaire_nodes (id, department, text_en, text_hi, text_te, q_type, options_json, required, next_default, next_rules, sort_order, is_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [node.id, node.department, node.text_en, node.text_hi, node.text_te, node.q_type,
         node.options_json ? JSON.stringify(node.options_json) : null, node.required,
         node.next_default, node.next_rules, node.sort_order, true]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Department code already exists' });
    console.error('create department error:', err);
    sendServerError(res, err);
  }
});

// Delete department (only if no doctors, sessions, or questions reference it)
router.delete('/departments/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();

    // Check for references
    const doctors = await pool.query('SELECT COUNT(*) FROM doctors WHERE department = $1', [code]);
    if (parseInt(doctors.rows[0].count) > 0) {
      return res.status(409).json({ error: `Cannot delete: ${doctors.rows[0].count} doctor(s) in this department` });
    }
    const sessions = await pool.query('SELECT COUNT(*) FROM sessions WHERE department = $1', [code]);
    if (parseInt(sessions.rows[0].count) > 0) {
      return res.status(409).json({ error: `Cannot delete: ${sessions.rows[0].count} session(s) in this department` });
    }
    const questions = await pool.query('SELECT COUNT(*) FROM questionnaire_nodes WHERE department = $1', [code]);
    if (parseInt(questions.rows[0].count) > 0) {
      return res.status(409).json({ error: `Cannot delete: ${questions.rows[0].count} question(s) in this department. Delete them first.` });
    }

    await pool.query('DELETE FROM departments WHERE code = $1', [code]);
    res.json({ deleted: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Questions ──

// List questions for department
router.get('/questions/:department', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM questionnaire_nodes WHERE department = $1 ORDER BY sort_order',
      [req.params.department.toUpperCase()]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create question
router.post('/questions', async (req, res) => {
  try {
    const { id, department, text_en, text_hi, text_te, q_type, options_json, required,
            triage_flag, triage_answer, next_default, next_rules, sort_order, is_base } = req.body;

    const result = await pool.query(
      `INSERT INTO questionnaire_nodes (id, department, text_en, text_hi, text_te, q_type, options_json, required, triage_flag, triage_answer, next_default, next_rules, sort_order, is_base)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, department, text_en, text_hi, text_te, q_type, options_json ? JSON.stringify(options_json) : null,
       required !== false, triage_flag || null, triage_answer || null, next_default || null,
       next_rules ? JSON.stringify(next_rules) : null, sort_order || 0, is_base === true]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('create question error:', err);
    sendServerError(res, err);
  }
});

// Update question
router.put('/questions/:id', async (req, res) => {
  try {
    const fields = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id') continue;
      sets.push(`${k} = $${i}`);
      vals.push(k.includes('json') || k === 'next_rules' ? JSON.stringify(v) : v);
      i++;
    }
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE questionnaire_nodes SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Delete question
router.delete('/questions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM questionnaire_nodes WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
