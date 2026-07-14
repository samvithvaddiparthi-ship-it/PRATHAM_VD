const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../models/db');
const { signToken, authMiddleware, requireRole } = require('../middleware/auth');
const { isLocked, recordFailure, clearFailures, MAX_ATTEMPTS } = require('../utils/loginLimiter');

const router = Router();

const IS_PROD = process.env.NODE_ENV === 'production';
const BCRYPT_ROUNDS = 10;
// SHA-256 of the seeded demo PIN "1234" — used to detect doctors still on the
// insecure default (§8b). We never hardcode the PIN itself, only its digest.
const DEMO_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';

// Every PHI route below goes through authMiddleware + requireRole rather than an
// inline token check, so a missing gate is visible at the route definition
// (§5a — `all-sessions` and `reassign` previously had no check at all).
const doctorOnly = [authMiddleware, requireRole('doctor')];
const clinicianOnly = [authMiddleware, requireRole('doctor', 'admin')];

// Legacy unsalted SHA-256 (kept only to verify pre-migration PINs once, then
// rehash with bcrypt — see §8b lazy migration in the login handler).
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

// Doctor PIN login
router.post('/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN required' });

    // §8b — lockout: reject early once this phone has failed too many times.
    const lock = await isLocked('doctor', String(phone));
    if (lock.locked) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfter / 60)} min.`,
      });
    }

    const result = await pool.query(
      'SELECT * FROM doctors WHERE phone = $1 AND is_active = true',
      [phone]
    );
    if (!result.rows.length) {
      await recordFailure('doctor', String(phone));
      return res.status(401).json({ error: 'Doctor not found' });
    }

    const doctor = result.rows[0];

    // §8b — verify against bcrypt if migrated, else the legacy SHA-256 hash.
    // On a successful legacy verify, lazily rehash the PIN with bcrypt so the
    // weak hash is never used again.
    let ok = false;
    if (doctor.pin_hash_bcrypt) {
      ok = await bcrypt.compare(String(pin), doctor.pin_hash_bcrypt);
    } else if (doctor.pin_hash) {
      ok = (doctor.pin_hash === hashPin(String(pin)));
      if (ok) {
        try {
          const bh = await bcrypt.hash(String(pin), BCRYPT_ROUNDS);
          await pool.query('UPDATE doctors SET pin_hash_bcrypt = $1 WHERE id = $2', [bh, doctor.id]);
        } catch { /* non-fatal — login still succeeds, migrates next time */ }
      }
    }

    if (!ok) {
      await recordFailure('doctor', String(phone));
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    // §8b — in production, refuse to admit a doctor still on the demo PIN even if
    // the row survived the startup guard (fail closed, like JWT_SECRET).
    if (IS_PROD && doctor.pin_hash === DEMO_PIN_HASH) {
      return res.status(403).json({ error: 'This account uses the default demo PIN. Ask an admin to reset it.' });
    }

    await clearFailures('doctor', String(phone));

    const token = signToken({
      doctor_id: doctor.id,
      doctor_name: doctor.name,
      department: doctor.department,
      role: 'doctor',
    });

    await pool.query(
      `INSERT INTO audit_log (event_type, actor, payload) VALUES ('doctor_login', $1, $2)`,
      [doctor.id, JSON.stringify({ name: doctor.name })]
    );

    res.json({
      token,
      doctor: { id: doctor.id, name: doctor.name, department: doctor.department, registration_no: doctor.registration_no || null },
    });
  } catch (err) {
    console.error('doctor login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new doctor (admin only)
router.post('/', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name, department, phone, pin, registration_no } = req.body;
    if (!name || !department || !phone || !pin) {
      return res.status(400).json({ error: 'name, department, phone, pin are required' });
    }
    if (pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    }
    if (IS_PROD && pin === '1234') {
      return res.status(400).json({ error: 'Refusing to set the well-known demo PIN (1234) in production.' });
    }

    // §8b — new PINs are stored as bcrypt only. pin_hash (NOT NULL legacy column)
    // is set to '' so there is no reversible SHA-256 hash on disk for new doctors.
    const bh = await bcrypt.hash(String(pin), BCRYPT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO doctors (name, department, phone, pin_hash, pin_hash_bcrypt, registration_no)
       VALUES ($1, $2, $3, '', $4, $5)
       RETURNING id, name, department, phone, registration_no, is_active, created_at`,
      [name, department.toUpperCase(), phone, bh, registration_no || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Phone number already registered' });
    }
    console.error('create doctor error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Edit a doctor's details (admin endpoint — no auth for POC).
// Updates only the fields provided. `pin` is optional: send it to reset the
// PIN, omit/blank it to keep the existing one (we never expose the live PIN).
router.patch('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name, department, phone, pin, registration_no } = req.body;
    const sets = [];
    const params = [];

    if (registration_no !== undefined) {
      params.push(String(registration_no).trim() || null); sets.push(`registration_no = $${params.length}`);
    }
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(String(name).trim()); sets.push(`name = $${params.length}`);
    }
    if (department !== undefined) {
      if (!String(department).trim()) return res.status(400).json({ error: 'department cannot be empty' });
      params.push(String(department).toUpperCase()); sets.push(`department = $${params.length}`);
    }
    if (phone !== undefined) {
      if (!String(phone).trim()) return res.status(400).json({ error: 'phone cannot be empty' });
      params.push(String(phone).trim()); sets.push(`phone = $${params.length}`);
    }
    if (pin !== undefined && pin !== '') {
      if (pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
        return res.status(400).json({ error: 'PIN must be 4-6 digits' });
      }
      if (IS_PROD && pin === '1234') {
        return res.status(400).json({ error: 'Refusing to set the well-known demo PIN (1234) in production.' });
      }
      // §8b — reset writes bcrypt and clears the legacy SHA-256 hash so the
      // account is no longer flagged as demo-PIN and has no reversible hash.
      const bh = await bcrypt.hash(String(pin), BCRYPT_ROUNDS);
      params.push(bh); sets.push(`pin_hash_bcrypt = $${params.length}`);
      params.push(''); sets.push(`pin_hash = $${params.length}`);
    }

    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE doctors SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, name, department, phone, registration_no, is_active, created_at`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Doctor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Phone number already registered' });
    }
    console.error('edit doctor error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deactivate a doctor (soft delete) — admin only
router.post('/:id/deactivate', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE doctors SET is_active = false WHERE id = $1 RETURNING id, name, is_active`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Doctor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reactivate a doctor (undo a soft delete) — admin only
router.post('/:id/reactivate', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE doctors SET is_active = true WHERE id = $1 RETURNING id, name, is_active`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Doctor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List doctors. The patient registration page reads this to offer a preferred
// doctor, so it takes any valid token — but a patient must not learn a doctor's
// personal phone or registration number, so those are stripped for patient
// tokens. Clinicians (HIS doctor management) get the full row.
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { department } = req.query;
    let q = 'SELECT id, name, department, phone, registration_no, is_active, created_at FROM doctors WHERE 1=1';
    const params = [];
    if (department) { params.push(department); q += ` AND department = $${params.length}`; }
    q += ' ORDER BY name';
    const result = await pool.query(q, params);

    const role = req.session_data && req.session_data.role;
    if (role !== 'doctor' && role !== 'admin') {
      return res.json(result.rows.map(({ phone, registration_no, ...safe }) => safe));
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get doctor's queue — assigned to them + unassigned in their department
router.get('/queue', ...doctorOnly, async (req, res) => {
  try {
    const { doctor_id, department } = req.session_data;

    // Patient directory: ALL completed visits in this department (full history,
    // not just the last 24h), so each patient's previous visits can be grouped
    // under them. `is_recent` (within 24h) marks a "filled now" visit — the
    // frontend uses it to highlight the latest entry and colour the patient
    // heading by that visit's triage. Each visit also carries its prescriptions.
    const result = await pool.query(
      `SELECT s.*, d.name as doctor_name,
         (s.created_at > NOW() - INTERVAL '24 hours'
           OR s.released_at > NOW() - INTERVAL '24 hours') AS is_recent,
         COALESCE((
           SELECT json_agg(json_build_object(
             'drug_name', pi.drug_name, 'dose', pi.dose,
             'frequency', pi.frequency, 'duration', pi.duration,
             'instructions', pi.instructions) ORDER BY pi.created_at)
           FROM prescriptions p
           JOIN prescription_items pi ON pi.prescription_id = p.id
           WHERE p.session_id = s.id
         ), '[]'::json) AS prescription_items
       FROM sessions s
       LEFT JOIN doctors d ON s.assigned_doctor_id = d.id
       WHERE s.state = 'COMPLETE'
         AND s.removed_at IS NULL
         AND (
           -- this department's completed visits (defines who's in the queue), PLUS
           s.department = $1
           -- every OTHER-department completed visit belonging to a patient who is in
           -- this department's queue — so a patient reassigned across departments
           -- still shows their full prior-visit history (grouped by phone+name).
           OR (
             s.patient_phone IS NOT NULL
             AND (s.patient_phone, lower(trim(coalesce(s.patient_name, '')))) IN (
               SELECT patient_phone, lower(trim(coalesce(patient_name, '')))
                 FROM sessions
                WHERE department = $1 AND state = 'COMPLETE' AND removed_at IS NULL
                  AND patient_phone IS NOT NULL
             )
           )
         )
       ORDER BY s.created_at DESC
       LIMIT 400`,
      [department]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('doctor queue error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign session to doctor (self-assign or by admin)
router.post('/assign/:session_id', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    // consulted_at is stamped ONCE (first open) and never overwritten, so the
    // Consulted list keeps a fixed order even when a patient is re-opened.
    const result = await pool.query(
      `UPDATE sessions SET assigned_doctor_id = $1, updated_at = NOW(),
              consulted_at = COALESCE(consulted_at, NOW())
       WHERE id = $2 RETURNING *`,
      [decoded.doctor_id, req.params.session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_assigned', $2, $3)`,
      [req.params.session_id, decoded.doctor_id, JSON.stringify({ doctor_name: decoded.doctor_name })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('assign error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// OPEN (lock) a patient's visit for consultation. Atomic: succeeds only if the
// visit is free or already mine and not yet dispatched. If another doctor holds
// it, returns 409 with their name so the UI can say "being consulted already".
router.post('/open/:session_id', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    // One active consultation per doctor: block opening a new patient while another
    // is still open (consulted, not yet dispatched). A patient merely reassigned to
    // me has consulted_at = NULL, so it doesn't count until I actually open it.
    const active = await pool.query(
      `SELECT id FROM sessions
        WHERE assigned_doctor_id = $1 AND consulted_at IS NOT NULL
          AND dispatched_at IS NULL AND id <> $2
        LIMIT 1`,
      [decoded.doctor_id, req.params.session_id]
    );
    if (active.rows.length) {
      return res.status(409).json({
        error: 'busy',
        message: 'Finish your current consultation (Save & Generate QR) before opening another patient.',
      });
    }

    const result = await pool.query(
      `UPDATE sessions
          SET assigned_doctor_id = $1,
              consulted_at = COALESCE(consulted_at, NOW()),
              updated_at = NOW()
        WHERE id = $2
          AND dispatched_at IS NULL
          AND (assigned_doctor_id IS NULL OR assigned_doctor_id = $1)
        RETURNING *`,
      [decoded.doctor_id, req.params.session_id]
    );

    if (!result.rows.length) {
      // Couldn't acquire — find out why (held by someone else, or already done).
      const cur = await pool.query(
        `SELECT s.assigned_doctor_id, s.dispatched_at, d.name AS doctor_name
           FROM sessions s LEFT JOIN doctors d ON s.assigned_doctor_id = d.id
          WHERE s.id = $1`,
        [req.params.session_id]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'Session not found' });
      const row = cur.rows[0];
      return res.status(409).json({
        error: 'locked',
        locked_by: row.doctor_name || 'another doctor',
        dispatched: !!row.dispatched_at,
      });
    }

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_opened', $2, $3)`,
      [req.params.session_id, decoded.doctor_id, JSON.stringify({ doctor_name: decoded.doctor_name })]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('open error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DISPATCH — the consultation is complete (Save & Generate QR clicked). Stamps
// dispatched_at, which removes the visit from the active queue and moves it into
// the doctor's Consulted list, releasing the lock.
router.post('/dispatch/:session_id', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    const result = await pool.query(
      `UPDATE sessions
          SET dispatched_at = NOW(),
              assigned_doctor_id = COALESCE(assigned_doctor_id, $1),
              consulted_at = COALESCE(consulted_at, NOW()),
              updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [decoded.doctor_id, req.params.session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_dispatched', $2, $3)`,
      [req.params.session_id, decoded.doctor_id, JSON.stringify({ doctor_name: decoded.doctor_name })]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('dispatch error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unassign session — send back to pool
router.post('/unassign/:session_id', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    // Abandon a lock — release the patient back to "waiting" (clear the doctor
    // link AND the consulted stamp so it's open for anyone again).
    const result = await pool.query(
      `UPDATE sessions SET assigned_doctor_id = NULL, consulted_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_unassigned', $2, $3)`,
      [req.params.session_id, decoded.doctor_id, JSON.stringify({ doctor_name: decoded.doctor_name })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('unassign error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Release a consulted visit back to the active queue. Unlike /unassign (which
// only drops the doctor link), this also CLEARS consulted_at — so the visit
// leaves the doctor's Consulted list entirely — and stamps released_at, which
// makes the queue treat it as "filled now" again (re-surfaces at the top with a
// NEW badge, like a fresh patient fill) and counts it as "waiting".
router.post('/release/:session_id', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    const result = await pool.query(
      `UPDATE sessions
          SET assigned_doctor_id = NULL, consulted_at = NULL, dispatched_at = NULL,
              released_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [req.params.session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_released', $2, $3)`,
      [req.params.session_id, decoded.doctor_id, JSON.stringify({ doctor_name: decoded.doctor_name })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('release error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reassign a session. Three modes by body:
//   { target_doctor_id }  → assign to that doctor AND move the visit into THAT
//                           doctor's department (the queue is department-filtered,
//                           so a cross-dept reassign must move the department too).
//   { department }        → move to that department's GENERAL queue (unassigned).
//   {}  / null            → unassign (back to the current department's general pool).
// In every assign/move case we clear the handoff stamps (consulted_at, dispatched_at)
// so the receiving doctor sees a fresh entry. Triage is preserved.
router.post('/reassign/:session_id', ...clinicianOnly, async (req, res) => {
  try {
    const { target_doctor_id, department } = req.body;

    // ── Reassign to a specific doctor (+ follow their department) ──
    if (target_doctor_id) {
      const doc = await pool.query('SELECT id, name, department FROM doctors WHERE id = $1 AND is_active = true', [target_doctor_id]);
      if (!doc.rows.length) return res.status(404).json({ error: 'Target doctor not found' });
      const dept = doc.rows[0].department;

      // Name of the doctor handing this patient over (the session's current owner),
      // recorded so the receiving doctor sees "Assigned to you by Dr. X".
      const fromRow = await pool.query(
        `SELECT d.name FROM sessions s JOIN doctors d ON d.id = s.assigned_doctor_id WHERE s.id = $1`,
        [req.params.session_id]
      );
      const fromName = fromRow.rows[0]?.name || null;

      const result = await pool.query(
        `UPDATE sessions SET assigned_doctor_id = $1, department = $2,
                reassigned_by = $3, reassigned_at = NOW(),
                consulted_at = NULL, dispatched_at = NULL,
                released_at = NOW(), updated_at = NOW()
         WHERE id = $4 RETURNING *`,
        [target_doctor_id, dept, fromName, req.params.session_id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

      await pool.query(
        `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_reassigned', 'admin', $2)`,
        [req.params.session_id, JSON.stringify({ target_doctor: doc.rows[0].name, target_id: target_doctor_id, department: dept })]
      );
      return res.json(result.rows[0]);
    }

    // ── Reassign to another department's GENERAL queue (no specific doctor) ──
    if (department) {
      const dep = await pool.query('SELECT code FROM departments WHERE code = $1', [department]);
      if (!dep.rows.length) return res.status(404).json({ error: 'Department not found' });

      const result = await pool.query(
        `UPDATE sessions SET department = $1, assigned_doctor_id = NULL,
                reassigned_by = NULL, reassigned_at = NULL,
                consulted_at = NULL, dispatched_at = NULL,
                released_at = NOW(), updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [department, req.params.session_id]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

      await pool.query(
        `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_dept_reassigned', 'admin', $2)`,
        [req.params.session_id, JSON.stringify({ department })]
      );
      return res.json(result.rows[0]);
    }

    // ── Neither provided → unassign (stay in current department's pool) ──
    const result = await pool.query(
      `UPDATE sessions SET assigned_doctor_id = NULL,
              reassigned_by = NULL, reassigned_at = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'doctor_unassigned', 'admin', '{}')`,
      [req.params.session_id]
    );
    return res.json(result.rows[0]);
  } catch (err) {
    console.error('reassign error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Doctor's consulted patients — completed sessions assigned to them
router.get('/consulted', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    // Consulted = visits I finished (Save & Generate QR → dispatched_at set).
    // Merely opening/locking a patient does NOT put them here.
    // A session can have MORE THAN ONE row in session_reports (e.g. the report
    // was regenerated after late vitals). A plain LEFT JOIN would then emit one
    // consulted row per report → duplicate cards. DISTINCT ON (s.id) collapses
    // each session to a single row, keeping its LATEST report.
    const result = await pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (s.id)
                s.*, sr.doctor_feedback, sr.created_at as report_created_at
         FROM sessions s
         LEFT JOIN session_reports sr ON sr.session_id = s.id
         WHERE s.assigned_doctor_id = $1
           AND s.state = 'COMPLETE'
           AND s.dispatched_at IS NOT NULL
           AND s.removed_at IS NULL
         ORDER BY s.id, sr.created_at DESC NULLS LAST
       ) t
       ORDER BY t.dispatched_at DESC
       LIMIT 100`,
      [decoded.doctor_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('consulted error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// All sessions with doctor info — for HIS/admin dashboard. Dumps the whole
// patient roster, so it is clinician-only (§5a: this had no auth at all).
router.get('/all-sessions', ...clinicianOnly, async (req, res) => {
  try {
    const { department, doctor_id, state, triage } = req.query;
    // display_state — the SINGLE source of truth for the HIS "State" column AND
    // the State filter. The raw `state` column stays COMPLETE once the pre-consult
    // report is generated and never changes through the doctor workflow, so it
    // can't tell "ready/waiting" from "in consultation" from "finished". Derive it
    // from the workflow stamps instead, using the dashboard-wide vocabulary:
    //   dispatched_at set              -> COMPLETED  (doctor finished: Save & Generate QR)
    //   consulted_at set, not finished -> STARTED    (doctor opened — consultation in progress)
    //   COMPLETE + not yet seen        -> READY      (pre-consult done, waiting for doctor)
    //   otherwise                      -> the pre-consult stage (REGISTERED/INTERVIEW/VITALS)
    // NB: a visit released from COMPLETED back to the queue has dispatched_at (and
    // consulted_at) cleared, so it correctly derives READY again.
    const displayStateSql = `CASE
        WHEN s.dispatched_at IS NOT NULL THEN 'COMPLETED'
        WHEN s.consulted_at IS NOT NULL THEN 'STARTED'
        WHEN s.state = 'COMPLETE' THEN 'READY'
        ELSE s.state END`;
    // A session can have MORE THAN ONE row in session_reports (e.g. the report was
    // regenerated after late vitals). A plain LEFT JOIN would then emit one row per
    // report → the same patient shows up twice/thrice on the dashboard. DISTINCT ON
    // (s.id) collapses each session to a single row, keeping its LATEST report
    // (same guard as /consulted). The outer query restores created_at DESC order.
    let inner = `SELECT DISTINCT ON (s.id)
             s.*, d.name as doctor_name, d.department as doctor_dept,
             sr.doctor_feedback, sr.created_at as report_created_at,
             ${displayStateSql} AS display_state
             FROM sessions s
             LEFT JOIN doctors d ON s.assigned_doctor_id = d.id
             LEFT JOIN session_reports sr ON sr.session_id = s.id
             WHERE s.state NOT IN ('INIT', 'CONSENTED')`;
    const params = [];
    if (department) { params.push(department); inner += ` AND s.department = $${params.length}`; }
    if (doctor_id) { params.push(doctor_id); inner += ` AND s.assigned_doctor_id = $${params.length}`; }
    // Filter on the DERIVED status so the dropdown and the column always agree.
    if (state) { params.push(state); inner += ` AND ${displayStateSql} = $${params.length}`; }
    if (triage) { params.push(triage); inner += ` AND s.triage_level = $${params.length}`; }
    inner += ' ORDER BY s.id, sr.created_at DESC NULLS LAST';
    const q = `SELECT * FROM (${inner}) t ORDER BY t.created_at DESC LIMIT 200`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    console.error('all-sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// "Delete" a patient entry — a SOFT remove. The session is stamped removed_at
// (not erased), so it drops out of the active Queue and the patient's
// previous-logins, but all its data is retained and it STAYS in the doctor's
// Consulted history if it was consulted. Guarded behind doctor auth.
router.delete('/session/:session_id', ...doctorOnly, async (req, res) => {
  const { session_id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE sessions SET removed_at = NOW() WHERE id = $1 RETURNING id, patient_name',
      [session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json({ removed: true, id: session_id, patient_name: result.rows[0].patient_name });
  } catch (err) {
    console.error('remove session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change PIN
router.post('/change-pin', ...doctorOnly, async (req, res) => {
  try {
    const decoded = req.session_data;

    const { old_pin, new_pin } = req.body;
    if (!old_pin || !new_pin) return res.status(400).json({ error: 'old_pin and new_pin required' });
    if (new_pin.length < 4 || new_pin.length > 6 || !/^\d+$/.test(new_pin)) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    if (IS_PROD && new_pin === '1234') return res.status(400).json({ error: 'Refusing to set the well-known demo PIN (1234) in production.' });

    const doc = await pool.query('SELECT pin_hash, pin_hash_bcrypt FROM doctors WHERE id = $1', [decoded.doctor_id]);
    if (!doc.rows.length) return res.status(401).json({ error: 'Invalid current PIN' });
    const row = doc.rows[0];
    // §8b — verify current PIN against bcrypt if migrated, else legacy SHA-256.
    let ok = false;
    if (row.pin_hash_bcrypt) ok = await bcrypt.compare(String(old_pin), row.pin_hash_bcrypt);
    else if (row.pin_hash) ok = (row.pin_hash === hashPin(String(old_pin)));
    if (!ok) return res.status(401).json({ error: 'Invalid current PIN' });

    // Store the new PIN as bcrypt only; clear the legacy hash.
    const bh = await bcrypt.hash(String(new_pin), BCRYPT_ROUNDS);
    await pool.query('UPDATE doctors SET pin_hash_bcrypt = $1, pin_hash = $2 WHERE id = $3', [bh, '', decoded.doctor_id]);
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
