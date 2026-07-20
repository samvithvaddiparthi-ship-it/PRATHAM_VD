const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = Router();

// Report tickets (migration 032) — the doctor flags a systemic issue with an AI
// summary ("a question is missing", "wrong extraction", …) to HIS, who review and
// fix it in the questionnaire editor. Raising is doctor/admin; managing is admin.
const raiseAccess = [authMiddleware, requireRole('doctor', 'admin')];
const adminOnly = [authMiddleware, requireRole('admin')];

const VALID_CATEGORIES = new Set(['missing_question', 'wrong_extraction', 'prompt_issue', 'triage_concern', 'other']);
const VALID_STATUSES = new Set(['open', 'triaged', 'resolved']);

// Raise a ticket against a patient's report/session.
router.post('/', ...raiseAccess, async (req, res) => {
  try {
    const { session_id, category, note } = req.body || {};
    if (!session_id || !category) return res.status(400).json({ error: 'session_id and category are required' });
    if (!VALID_CATEGORIES.has(category)) return res.status(400).json({ error: 'Unknown category' });

    // Derive the department from the session so HIS can jump straight to the right
    // questionnaire; also confirms the session exists.
    const s = await pool.query('SELECT department FROM sessions WHERE id = $1', [session_id]);
    if (!s.rows.length) return res.status(404).json({ error: 'Session not found' });

    const claims = req.session_data || {};
    const result = await pool.query(
      `INSERT INTO report_tickets (session_id, department, raised_by, raised_by_name, category, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [session_id, s.rows[0].department || null,
       claims.role === 'doctor' ? (claims.doctor_id || null) : null,
       (claims.doctor_name || claims.admin_name || 'Unknown').slice(0, 128),
       category, (note || '').trim() || null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    sendServerError(res, err);
  }
});

// List tickets (admin) — newest first, optional ?status= filter. Joins the patient
// name so HIS can see who it's about.
router.get('/', ...adminOnly, async (req, res) => {
  try {
    const { status } = req.query;
    const vals = [];
    let where = '';
    if (status && VALID_STATUSES.has(status)) { vals.push(status); where = 'WHERE t.status = $1'; }
    const result = await pool.query(
      `SELECT t.*, s.patient_name
       FROM report_tickets t LEFT JOIN sessions s ON t.session_id = s.id
       ${where}
       ORDER BY t.created_at DESC LIMIT 200`, vals
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Open-ticket count (admin) — powers the badge on the HIS Tickets tab.
router.get('/count', ...adminOnly, async (req, res) => {
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS open FROM report_tickets WHERE status = 'open'");
    res.json({ success: true, data: { open: r.rows[0].open } });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Update a ticket (admin) — change status and/or record a resolution note.
router.patch('/:id', ...adminOnly, async (req, res) => {
  try {
    const { status, resolution } = req.body || {};
    if (status && !VALID_STATUSES.has(status)) return res.status(400).json({ error: 'Unknown status' });

    const sets = [];
    const vals = [];
    let i = 1;
    if (status) {
      sets.push(`status = $${i++}`); vals.push(status);
      if (status === 'resolved') {
        sets.push(`resolved_at = NOW()`);
        sets.push(`resolved_by = $${i++}`); vals.push((req.session_data?.admin_name || 'admin').slice(0, 128));
      }
    }
    if (resolution !== undefined) { sets.push(`resolution = $${i++}`); vals.push((resolution || '').trim() || null); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE report_tickets SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
