const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { baseNodesForDept } = require('../seed/baseTemplate');
const { signToken, authMiddleware, requireRole } = require('../middleware/auth');
const { isLocked, recordFailure, clearFailures } = require('../utils/loginLimiter');

const router = Router();

// Best-effort client IP for the shared-passcode login limiter (§8b). Behind the
// proxy the first X-Forwarded-For hop is the real client; falls back to the
// socket peer. Admin login is a single shared credential, so we throttle per
// source IP rather than per account.
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// Admin-only guard for all mutating config routes below. GET (config reads) stay
// open — they expose department/question config, not patient PHI.
const adminOnly = [authMiddleware, requireRole('admin')];

// ── Admin login ──
// Verifies the shared admin passcode (env ADMIN_PASSCODE) and issues an
// admin-role JWT for the HIS dashboard. POC-grade shared credential — per-user
// admin accounts / SSO is a later decision. Fails closed if not configured.
router.post('/login', async (req, res) => {
  try {
    const expected = (process.env.ADMIN_PASSCODE || '').trim();
    if (!expected || expected.length < 6) {
      return res.status(503).json({ error: 'Admin login is not configured. Set a strong ADMIN_PASSCODE.' });
    }
    // §8b — lockout on repeated failures from the same source.
    const ip = clientIp(req);
    const lock = await isLocked('admin', ip);
    if (lock.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfter / 60)} min.` });
    }
    const passcode = String((req.body || {}).passcode || '');
    if (!passcode) return res.status(400).json({ error: 'Passcode required' });
    // Named-admin audit (A9): each admin identifies themselves so their actions are
    // attributable in audit_log. This is NOT a second credential — the passcode is
    // still the gate — just a label carried in the token for the audit trail.
    const adminName = String((req.body || {}).admin_name || '').trim().slice(0, 80);
    if (adminName.length < 2) return res.status(400).json({ error: 'Enter your name' });
    // Constant-time comparison (avoids timing leaks); unequal lengths => reject.
    const a = Buffer.from(passcode);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      await recordFailure('admin', ip);
      return res.status(401).json({ error: 'Invalid passcode' });
    }
    await clearFailures('admin', ip);

    const token = signToken({ role: 'admin', admin_name: adminName });
    try {
      await pool.query(
        `INSERT INTO audit_log (event_type, actor, payload) VALUES ('admin_login', $1, $2)`,
        [adminName, JSON.stringify({})]
      );
    } catch { /* audit_log optional */ }
    res.json({ token });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Departments ──

// List departments
router.get('/departments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet — return hardcoded defaults
    res.json([
      { code: 'CARD', name: 'Cardiology', is_active: true, collect_vitals: true },
      { code: 'GEN', name: 'General Medicine', is_active: true, collect_vitals: true },
    ]);
  }
});

// Create department
router.post('/departments', ...adminOnly, async (req, res) => {
  try {
    const { code, name, collect_vitals, icon } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const cleanCode = code.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (cleanCode.length < 2) return res.status(400).json({ error: 'Code must be at least 2 characters (letters/numbers only)' });

    const result = await pool.query(
      'INSERT INTO departments (code, name, collect_vitals, icon) VALUES ($1, $2, $3, $4) RETURNING *',
      [cleanCode, name, collect_vitals === undefined ? true : !!collect_vitals, (icon || '').trim() || null]
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

// Update a department (name and/or the collect_vitals toggle). Only the provided
// fields are changed.
router.patch('/departments/:code', ...adminOnly, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { name, collect_vitals, icon } = req.body;
    const sets = [];
    const params = [];

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(String(name).trim()); sets.push(`name = $${params.length}`);
    }
    if (collect_vitals !== undefined) {
      params.push(!!collect_vitals); sets.push(`collect_vitals = $${params.length}`);
    }
    if (icon !== undefined) {
      // Empty string clears the icon (falls back to the code-based guess).
      params.push(String(icon).trim() || null); sets.push(`icon = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(code);
    const result = await pool.query(
      `UPDATE departments SET ${sets.join(', ')} WHERE code = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Department not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Delete department (only if no doctors, sessions, or questions reference it)
router.delete('/departments/:code', ...adminOnly, async (req, res) => {
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
router.post('/questions', ...adminOnly, async (req, res) => {
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
router.put('/questions/:id', ...adminOnly, async (req, res) => {
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
router.delete('/questions/:id', ...adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM questionnaire_nodes WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
