const { Router } = require('express');
const pool = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const router = Router();

// Submit vitals
router.post('/:session_id', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.params;
    const { bp_systolic, bp_diastolic, bp_side, weight_kg, spo2_pct, heart_rate, temperature_c, source } = req.body;

    const result = await pool.query(
      `INSERT INTO session_vitals (session_id, bp_systolic, bp_diastolic, bp_side, weight_kg, spo2_pct, heart_rate, temperature_c, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [session_id, bp_systolic, bp_diastolic, bp_side || 'left', weight_kg, spo2_pct, heart_rate, temperature_c, source || 'manual']
    );

    // Advance the session to VITALS — but NEVER downgrade a session that has
    // already COMPLETED (e.g. vitals entered late from the queue page). Doing so
    // would pull the patient out of the doctor's queue. The late flow re-runs
    // report generation, which sets COMPLETE again.
    await pool.query(
      `UPDATE sessions SET state = 'VITALS', updated_at = NOW() WHERE id = $1 AND state <> 'COMPLETE'`,
      [session_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('vitals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get vitals for session
router.get('/:session_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM session_vitals WHERE session_id = $1 ORDER BY recorded_at DESC LIMIT 1',
      [req.params.session_id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('get vitals error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
