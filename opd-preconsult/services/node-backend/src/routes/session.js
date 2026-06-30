const { Router } = require('express');
const pool = require('../models/db');
const { signToken, authMiddleware } = require('../middleware/auth');
const { normalizeIndianPhone } = require('../utils/phone');

const router = Router();

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
    if (!hospital_id || !department) {
      return res.status(400).json({ error: 'Missing hospital_id or department' });
    }

    const result = await pool.query(
      `INSERT INTO sessions (hospital_id, department, queue_slot, state)
       VALUES ($1, $2, $3, 'INIT') RETURNING *`,
      [hospital_id, department, queue_slot || null]
    );

    const session = result.rows[0];
    const token = signToken({ session_id: session.id, hospital_id, department, role: 'patient' });

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
    const { patient_name, patient_phone, patient_age, patient_gender, language } = req.body;

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

    // Gate on OTP: the session must have passed phone verification (POST
    // /api/otp/verify) and the number being registered must be the exact one that
    // was verified — so the request can't be edited to register a different,
    // unverified number after the code check.
    const guard = await pool.query(
      'SELECT phone_verified, patient_phone FROM sessions WHERE id = $1',
      [session_id]
    );
    if (!guard.rows.length) return res.status(404).json({ error: 'Session not found' });
    if (!guard.rows[0].phone_verified || guard.rows[0].patient_phone !== normalizedPhone) {
      return res.status(403).json({ error: 'Phone not verified' });
    }

    const result = await pool.query(
      `UPDATE sessions SET
        patient_name = $1, patient_phone = $2, patient_age = $3,
        patient_gender = $4, language = COALESCE($5, language),
        state = 'REGISTERED', updated_at = NOW()
       WHERE id = $6 RETURNING *`,
      [patient_name, normalizedPhone, patient_age || null, patient_gender || null, language, session_id]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });

    // Assign a daily, per-department token (gov-OPD style) — once per session, so
    // navigating Back and re-submitting keeps the same number. The atomic upsert
    // is race-safe and the counter resets each day (keyed by service_date).
    let sess = result.rows[0];
    if (sess.token_number == null) {
      const tok = await pool.query(
        `INSERT INTO queue_counters (hospital_id, department, service_date, last_token)
         VALUES ($1, $2, CURRENT_DATE, 1)
         ON CONFLICT (hospital_id, department, service_date)
         DO UPDATE SET last_token = queue_counters.last_token + 1
         RETURNING last_token`,
        [sess.hospital_id, sess.department]
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
    const nameKey = String(patient_name).trim().toLowerCase();
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

// Update session state
router.post('/state', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const { state } = req.body;
    const valid = ['INIT', 'REGISTERED', 'CONSENTED', 'INTERVIEW', 'VITALS', 'COMPLETE'];
    if (!valid.includes(state)) return res.status(400).json({ error: 'Invalid state' });

    const result = await pool.query(
      `UPDATE sessions SET state = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [state, session_id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('state error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get session by ID
router.get('/:id', async (req, res) => {
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

// List sessions (for doctor queue)
router.get('/', async (req, res) => {
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
