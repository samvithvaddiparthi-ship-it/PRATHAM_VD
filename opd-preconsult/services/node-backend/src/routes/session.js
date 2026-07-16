const { Router } = require('express');
const pool = require('../models/db');
const { signToken, authMiddleware, requireRole, requireSessionOwnership } = require('../middleware/auth');
const { normalizeIndianPhone } = require('../utils/phone');
const { APP_TIMEZONE } = require('../utils/time');

const router = Router();

// Hard sanity bound on patient age. Like VITAL_LIMITS in routes/vitals.js this is a
// data-error guard, not a clinical range — kept wide so no real patient is rejected
// (the oldest verified human reached 122).
const MAX_AGE = 120;
const INVALID_AGE = Symbol('invalid_age');

// '' / null / undefined -> null (age is optional). A valid whole 0..MAX_AGE -> that
// number. Anything else -> INVALID_AGE. Note 0 must survive as 0 (infants), which a
// plain `patient_age || null` would quietly turn into null.
function normalizeAge(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_AGE) return INVALID_AGE;
  return n;
}

// How long an unfinished visit keeps blocking a re-entry for the same person.
// A visit abandoned mid-flow (patient closes the tab at interview/vitals) is never
// dispatched or removed, so without a cutoff it would block that name+phone from
// EVER registering again. We only treat a prior open visit as "still in progress"
// if it was touched within this window (default 12h — an OPD is same-day). Env-
// tunable; 0 disables the window (old behaviour: any open visit blocks forever).
const ACTIVE_VISIT_WINDOW_HOURS = (() => {
  const n = parseInt(process.env.ACTIVE_VISIT_WINDOW_HOURS, 10);
  return Number.isFinite(n) ? n : 12;
})();
// SQL fragment appended to the "already active" guards. Empty when disabled.
const ACTIVE_WINDOW_SQL = ACTIVE_VISIT_WINDOW_HOURS > 0
  ? `AND updated_at > NOW() - make_interval(hours => ${ACTIVE_VISIT_WINDOW_HOURS})`
  : '';

// Decode QR and create session
router.post('/scan', async (req, res) => {
  try {
    const { qr_payload } = req.body;
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(qr_payload, 'base64').toString());
    } catch {
      return res.status(400).json({ error: 'Invalid QR payload' });
    }

    const { hospital_id, department, queue_slot } = decoded;
    if (!hospital_id) {
      return res.status(400).json({ error: 'Missing hospital_id' });
    }
    // department is OPTIONAL now — the patient chooses it after OTP + details, and
    // it's set at /register (before the queue token is issued). A legacy
    // department-scoped QR may still carry one, which we honour if present.

    const result = await pool.query(
      `INSERT INTO sessions (hospital_id, department, queue_slot, state)
       VALUES ($1, $2, $3, 'INIT') RETURNING *`,
      [hospital_id, department || null, queue_slot || null]
    );

    const session = result.rows[0];
    const token = signToken({ session_id: session.id, hospital_id, department: department || null, role: 'patient' });

    res.json({ session, token });
  } catch (err) {
    console.error('scan error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register patient identity
router.post('/register', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const { patient_name, patient_phone, patient_age, patient_gender, language,
            department, preferred_doctor_id, preferred_doctor_name } = req.body;

    if (!patient_name || !patient_phone) {
      return res.status(400).json({ error: 'Name and phone required' });
    }

    // Normalize the phone to canonical E.164 (+91XXXXXXXXXX) and reject anything
    // that isn't a valid Indian mobile — don't trust the client's formatting. We
    // store and match on this normalized form everywhere below.
    const { e164: normalizedPhone, valid: phoneValid } = normalizeIndianPhone(patient_phone);
    if (!phoneValid) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Age sanity guard — mirrors VITAL_LIMITS in routes/vitals.js and the input cap
    // on the register page. MAX_AGE is a sanity bound (oldest verified human: 122),
    // not a clinical one: it rejects fat-finger/garbage (age 9999, -5, "abc") that
    // would otherwise reach an INTEGER column and skew triage and the report.
    // Age is optional — absent/blank stays null.
    const age = normalizeAge(patient_age);
    if (age === INVALID_AGE) {
      return res.status(400).json({ error: `Age must be a whole number between 0 and ${MAX_AGE}` });
    }

    // Gate on OTP: the session must have passed phone verification (POST
    // /api/otp/verify) and the number being registered must be the exact one that
    // was verified — so the request can't be edited to register a different,
    // unverified number after the code check.
    const guard = await pool.query(
      'SELECT phone_verified, patient_phone, state, dispatched_at FROM sessions WHERE id = $1',
      [session_id]
    );
    if (!guard.rows.length) return res.status(404).json({ error: 'Session not found' });
    if (!guard.rows[0].phone_verified || guard.rows[0].patient_phone !== normalizedPhone) {
      return res.status(403).json({ error: 'Phone not verified' });
    }
    // Never re-register a session that's already finished (completed pre-consult
    // or dispatched by the doctor). This can only happen if a stale token leaked
    // from a previous visit — refuse so the patient starts a fresh scan instead
    // of resurrecting a done session (which caused the skip-to-vitals bug).
    if (guard.rows[0].state === 'COMPLETE' || guard.rows[0].dispatched_at) {
      return res.status(409).json({ error: 'session_finished' });
    }

    // A patient is identified by phone + name (one number may serve a whole
    // family). Block a SECOND entry for the same person only while they have a
    // COMPLETED visit still open — i.e. one that finished the pre-consult and is
    // waiting in the doctor's queue or being consulted (not yet dispatched). A
    // DIFFERENT name on the same number is allowed through normally. The frontend
    // turns 'already_active' into a wait message.
    const nameKey = String(patient_name).trim().toLowerCase();
    // An abandoned draft — the patient started a visit but never FINISHED the
    // pre-consult, so it never reached the doctor's queue (state still INIT/
    // REGISTERED/INTERVIEW/VITALS) — must NOT block this person from starting
    // again, and the doctor can't see or clear it. Supersede any such prior
    // INCOMPLETE session for this phone+name (soft-delete via removed_at). Only a
    // COMPLETED visit — waiting in the queue or being consulted — counts as a real
    // active duplicate worth blocking.
    await pool.query(
      `UPDATE sessions SET removed_at = NOW(), updated_at = NOW()
        WHERE patient_phone = $1 AND lower(trim(patient_name)) = $2
          AND id <> $3 AND removed_at IS NULL AND dispatched_at IS NULL
          AND state <> 'COMPLETE'`,
      [normalizedPhone, nameKey, session_id]
    );
    const active = await pool.query(
      `SELECT 1 FROM sessions
        WHERE patient_phone = $1
          AND lower(trim(patient_name)) = $2
          AND id <> $3
          AND removed_at IS NULL
          AND dispatched_at IS NULL
          AND state = 'COMPLETE'
          ${ACTIVE_WINDOW_SQL}
        LIMIT 1`,
      [normalizedPhone, nameKey, session_id]
    );
    if (active.rows.length) {
      return res.status(409).json({ error: 'already_active' });
    }

    const result = await pool.query(
      `UPDATE sessions SET
        patient_name = $1, patient_phone = $2, patient_age = $3,
        patient_gender = $4, language = COALESCE($5, language),
        department = COALESCE($6, department),
        preferred_doctor_id = $7, preferred_doctor_name = $8,
        state = 'REGISTERED', updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [patient_name, normalizedPhone, age, patient_gender || null, language,
       department ? String(department).toUpperCase() : null,
       preferred_doctor_id || null, (preferred_doctor_name || '').trim() || null, session_id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    // The department is now chosen after details, so it must be present before we
    // issue a queue token (the session was created without one at scan).
    let sess = result.rows[0];
    if (!sess.department) {
      return res.status(400).json({ error: 'Department required' });
    }

    // Assign a daily, per-department token (gov-OPD style) — once per session, so
    // navigating Back and re-submitting keeps the same number. The atomic upsert
    // is race-safe and the counter resets each day. The "service day" rolls over
    // at LOCAL (IST) midnight, not the DB server's UTC midnight — so tokens reset
    // at 12am hospital time regardless of server timezone.
    if (sess.token_number == null) {
      const tok = await pool.query(
        `INSERT INTO queue_counters (hospital_id, department, service_date, last_token)
         VALUES ($1, $2, (NOW() AT TIME ZONE $3)::date, 1)
         ON CONFLICT (hospital_id, department, service_date)
         DO UPDATE SET last_token = queue_counters.last_token + 1
         RETURNING last_token`,
        [sess.hospital_id, sess.department, APP_TIMEZONE]
      );
      const n = tok.rows[0].last_token;
      const label = `${sess.department}-${String(n).padStart(3, '0')}`;
      const upd = await pool.query(
        `UPDATE sessions SET token_number = $1, token_label = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [n, label, sess.id]
      );
      sess = upd.rows[0];
    }

    // Look up THIS person's prior visits. One phone may serve a whole family, so
    // a patient is identified by phone + name (case/space-insensitive), not phone
    // alone — otherwise a relative's visits would be miscounted as this person's.
    // Only COMPLETED visits count (a visit "counts" once submitted). The current
    // session is excluded (it isn't complete yet anyway).
    const history = await pool.query(
      `SELECT created_at, department
         FROM sessions
        WHERE patient_phone = $1
          AND lower(trim(patient_name)) = $3
          AND id <> $2
          AND state = 'COMPLETE'
          AND removed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 5`,
      [normalizedPhone, session_id, nameKey]
    );
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM sessions
        WHERE patient_phone = $1
          AND lower(trim(patient_name)) = $3
          AND id <> $2
          AND state = 'COMPLETE'
          AND removed_at IS NULL`,
      [normalizedPhone, session_id, nameKey]
    );

    res.json({
      ...sess,
      previous_login_count: countResult.rows[0].count,
      previous_logins: history.rows,
    });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Is THIS person (the session's verified phone + the given name) already in an
// open visit — registered/in-progress/being-consulted but not finished? Lets the
// entry form warn the moment a name is chosen (before the department step),
// instead of only at the final register. Same rule as the /register guard.
router.post('/active-check', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.json({ active: false });
    const s = await pool.query('SELECT patient_phone FROM sessions WHERE id = $1', [session_id]);
    const phone = s.rows[0]?.patient_phone;
    if (!phone) return res.json({ active: false });
    // Same rule as the /register guard: only a COMPLETED visit (in the queue or
    // being consulted) counts as active — an unfinished draft never does.
    const r = await pool.query(
      `SELECT 1 FROM sessions
        WHERE patient_phone = $1
          AND lower(trim(patient_name)) = lower(trim($2))
          AND id <> $3
          AND removed_at IS NULL
          AND dispatched_at IS NULL
          AND state = 'COMPLETE'
          ${ACTIVE_WINDOW_SQL}
        LIMIT 1`,
      [phone, name, session_id]
    );
    res.json({ active: r.rows.length > 0 });
  } catch (err) {
    res.json({ active: false });   // fail open — the /register guard is the backstop
  }
});

// Give consent
router.post('/consent', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    // Record consent without introducing a separate CONSENTED state — the
    // session stays REGISTERED until the interview begins (then -> INTERVIEW).
    // CONSENTED is no longer used as a state anywhere.
    const result = await pool.query(
      `UPDATE sessions SET consent_given = true, consent_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor) VALUES ($1, 'consent_given', 'patient')`,
      [session_id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('consent error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// NOTE: a generic "set session state" endpoint used to live here. It was removed
// because it let a patient token PATCH its own session to any state — including
// COMPLETE, which is the doctor-queue entry criterion — bypassing the interview
// and report. It had no callers. State transitions are owned by the flow that
// performs them: the questionnaire advances to INTERVIEW, vitals -> VITALS, and
// report generation sets COMPLETE. Do not reintroduce a client-settable state.

// Get session by ID — the patient's own flow (done/interview pages) and the
// clinician views both read this. A patient may only read their OWN session
// (§5c); doctors/admins may read any.
router.get('/:id', authMiddleware, requireSessionOwnership('id'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, COALESCE(d.collect_vitals, true) AS collect_vitals
       FROM sessions s LEFT JOIN departments d ON d.code = s.department
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('get session error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List sessions (for doctor queue) — bulk PHI, clinicians only.
router.get('/', authMiddleware, requireRole('doctor', 'admin'), async (req, res) => {
  try {
    const { department, state } = req.query;
    let query = 'SELECT * FROM sessions WHERE 1=1';
    const params = [];
    if (department) { params.push(department); query += ` AND department = $${params.length}`; }
    if (state) { params.push(state); query += ` AND state = $${params.length}`; }
    query += ' ORDER BY created_at DESC LIMIT 50';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('list sessions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
