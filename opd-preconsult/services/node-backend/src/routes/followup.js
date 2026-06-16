const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');

const router = Router();

// List follow-ups (optionally filter by status)
router.get('/', async (req, res) => {
  try {
    const { status, phone } = req.query;
    let sql = 'SELECT f.*, s.patient_name, s.department FROM scheduled_followups f JOIN sessions s ON f.session_id = s.id';
    const conditions = [];
    const vals = [];
    let i = 1;

    if (status) { conditions.push(`f.status = $${i++}`); vals.push(status); }
    if (phone) { conditions.push(`f.patient_phone = $${i++}`); vals.push(phone); }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY f.send_at DESC LIMIT 100';

    const result = await pool.query(sql, vals);
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Schedule a follow-up manually
router.post('/', async (req, res) => {
  try {
    const { session_id, protocol_id, patient_phone, message, send_at, channel } = req.body;
    if (!session_id || !patient_phone || !message || !send_at) {
      return res.status(400).json({ error: 'session_id, patient_phone, message, and send_at required' });
    }
    const result = await pool.query(
      `INSERT INTO scheduled_followups (session_id, protocol_id, patient_phone, message, send_at, channel)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [session_id, protocol_id || null, patient_phone, message, send_at, channel || 'whatsapp']
    );
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Record patient response to a follow-up
router.post('/:id/respond', async (req, res) => {
  try {
    const { response } = req.body;
    const responseLower = (response || '').toLowerCase();
    let newStatus = 'responded';
    if (['better', 'good', 'ok', 'fine', 'recovered'].some(w => responseLower.includes(w))) {
      newStatus = 'closed';
    } else if (['same', 'worse', 'bad', 'not better', 'no'].some(w => responseLower.includes(w))) {
      newStatus = 'needs_followup';
    }

    await pool.query(
      `UPDATE scheduled_followups SET patient_response = $1, response_at = NOW(), status = $2 WHERE id = $3`,
      [response, newStatus, req.params.id]
    );
    res.json({ status: newStatus });
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
