const { Router } = require('express');
const pool = require('../models/db');
const { authMiddleware, requireSessionOwnership } = require('../middleware/auth');

const router = Router();

// Hard physiological sanity limits [min, max] per vital. These reject impossible /
// fat-finger entries (e.g. HR 7000, SpO2 150) — NOT clinical normal ranges. A value
// outside these is a data error, so we refuse it rather than store garbage that
// would skew triage/report. Kept intentionally wide so no real reading is rejected.
const VITAL_LIMITS = {
  bp_systolic:   [0, 999],
  bp_diastolic:  [0, 999],
  spo2_pct:      [0, 100],
  heart_rate:    [0, 999],
  temperature_c: [0, 99],
  weight_kg:     [0, 999],
};

// Returns an error string if any provided vital is non-numeric or out of range,
// else null. Absent/blank fields are allowed (vitals are optional per-field).
function validateVitals(body) {
  for (const [key, [min, max]] of Object.entries(VITAL_LIMITS)) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) return `${key} must be a number`;
    if (n < min || n > max) return `${key} must be between ${min} and ${max}`;
  }

  // Cross-field: systolic must exceed diastolic. The per-field ranges above are
  // deliberately wide, so each half of a transposed reading passes on its own —
  // only comparing them catches it. This matters clinically: 120/80 entered as
  // 80/120 gives a systolic of 80, which trips the "< 90 → shock" rule in
  // triage.py and marks a well patient RED. Only enforced when both are present.
  const sys = Number(body.bp_systolic);
  const dia = Number(body.bp_diastolic);
  const hasSys = body.bp_systolic !== undefined && body.bp_systolic !== null && body.bp_systolic !== '';
  const hasDia = body.bp_diastolic !== undefined && body.bp_diastolic !== null && body.bp_diastolic !== '';
  if (hasSys && hasDia && Number.isFinite(sys) && Number.isFinite(dia) && dia >= sys) {
    return 'bp_systolic must be greater than bp_diastolic';
  }
  return null;
}

// Submit vitals — a patient submits their own; clinicians may enter for any
// session (§5c ownership; role bypass for doctor/admin).
router.post('/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
  try {
    const { session_id } = req.params;
    const { bp_systolic, bp_diastolic, bp_side, weight_kg, spo2_pct, heart_rate, temperature_c, source } = req.body;

    const invalid = validateVitals(req.body);
    if (invalid) return res.status(400).json({ error: invalid });

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

// Get vitals for session — own session (patient) or any (clinician).
router.get('/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
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
