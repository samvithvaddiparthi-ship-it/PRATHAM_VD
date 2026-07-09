const { Router } = require('express');
const pool = require('../models/db');
const { APP_TIMEZONE } = require('../utils/time');

const router = Router();

// PUBLIC waiting-room board for a department — like a standard government-OPD
// "Now Serving" display. No auth, so it must expose token numbers ONLY.
//
//   now_serving = visits a doctor has opened (being consulted), not yet dispatched
//   waiting     = completed pre-consults not yet picked up (urgent-first, then arrival)
//
// triage_level MUST NOT be selected here. It is health data about an identifiable
// person: a token becomes a face the moment it is called, so publishing acuity on
// a screen in a crowded waiting area discloses a patient's clinical status to
// everyone present — sensitive personal data under the DPDP Act 2023, with no
// consent basis. Triage stays in the ORDER BY (call priority is the point) but
// never leaves the server.
//
// Triage ordering mirrors the doctor dashboard's call order; if mentors choose a
// strict first-come-first-served policy later, only the ORDER BY changes.
router.get('/board', async (req, res) => {
  try {
    const department = (req.query.department || '').trim();
    if (!department) return res.status(400).json({ error: 'department required' });

    const nowServing = await pool.query(
      `SELECT token_label
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
      `SELECT token_label
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

// PUBLIC "last issued token" per department — lets the kiosk department picker
// show how far each department has counted today (e.g. CARD-042) so a patient can
// gauge how busy it is before choosing. Token numbers only, no PHI, no auth (same
// contract as /board). Reads the same daily counter (queue_counters) that
// /register increments; label format mirrors session.js exactly (DEPT-NNN).
//   ?department=CARD → that one department
//   (no param)       → every department that has issued a token today (one call)
router.get('/last', async (req, res) => {
  try {
    const label = (dept, n) => `${dept}-${String(n).padStart(3, '0')}`;
    const department = (req.query.department || '').trim();

    if (department) {
      const r = await pool.query(
        `SELECT COALESCE(MAX(last_token), 0) AS last_token
           FROM queue_counters
          WHERE department = $1 AND service_date = (NOW() AT TIME ZONE $2)::date`,
        [department, APP_TIMEZONE]
      );
      const n = r.rows[0].last_token;
      return res.json({
        department,
        last_token: n,
        token_label: n > 0 ? label(department, n) : null,
      });
    }

    // Aggregate across hospitals defensively (demo is single-hospital, but the
    // counter is keyed by hospital too) — the picker only cares about the highest
    // token issued per department today.
    const r = await pool.query(
      `SELECT department, MAX(last_token) AS last_token
         FROM queue_counters
        WHERE service_date = (NOW() AT TIME ZONE $1)::date
        GROUP BY department`,
      [APP_TIMEZONE]
    );
    const departments = r.rows.map((row) => ({
      department: row.department,
      last_token: row.last_token,
      token_label: row.last_token > 0 ? label(row.department, row.last_token) : null,
    }));
    res.json({ departments, updated_at: new Date().toISOString() });
  } catch (err) {
    console.error('queue last error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
