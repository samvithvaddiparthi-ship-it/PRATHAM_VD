const { Router } = require('express');
const pool = require('../models/db');

const router = Router();

// PUBLIC waiting-room board for a department — like a standard government-OPD
// "Now Serving" display. No auth: it exposes token numbers ONLY (no patient
// names/phones/PHI), so it is safe to show on a screen in the waiting area.
//
//   now_serving = visits a doctor has opened (being consulted), not yet dispatched
//   waiting     = completed pre-consults not yet picked up (urgent-first, then arrival)
//
// Triage ordering mirrors the doctor dashboard's call order; if mentors choose a
// strict first-come-first-served policy later, only the ORDER BY changes.
router.get('/board', async (req, res) => {
  try {
    const department = (req.query.department || '').trim();
    if (!department) return res.status(400).json({ error: 'department required' });

    const nowServing = await pool.query(
      `SELECT token_label, triage_level
         FROM sessions
        WHERE department = $1
          AND assigned_doctor_id IS NOT NULL
          AND consulted_at IS NOT NULL
          AND dispatched_at IS NULL
          AND removed_at IS NULL
          AND token_label IS NOT NULL
        ORDER BY consulted_at ASC`,
      [department]
    );

    const waiting = await pool.query(
      `SELECT token_label, triage_level
         FROM sessions
        WHERE department = $1
          AND state = 'COMPLETE'
          AND consulted_at IS NULL
          AND dispatched_at IS NULL
          AND removed_at IS NULL
          AND token_label IS NOT NULL
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY
          CASE triage_level WHEN 'RED' THEN 0 WHEN 'AMBER' THEN 1 WHEN 'GREEN' THEN 2 ELSE 3 END,
          created_at ASC`,
      [department]
    );

    res.json({
      department,
      now_serving: nowServing.rows,
      waiting: waiting.rows,
      waiting_count: waiting.rows.length,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('queue board error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
