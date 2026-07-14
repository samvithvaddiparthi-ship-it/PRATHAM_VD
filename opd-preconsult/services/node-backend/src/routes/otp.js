const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { sendServerError } = require('../utils/http');
const { normalizeIndianPhone } = require('../utils/phone');
const { sendSms, smsConfigured } = require('../utils/sms');

const router = Router();

// ── Phone-number OTP verification ────────────────────────────────────────────
// Gates patient registration on proof that an SMS reached the entered number.
// Codes are 6 digits, valid 5 minutes, hashed at rest, attempt-capped, and rate
// limited per session. Verification is recorded on the session — multiple people
// may share a phone, so this proves "the SMS reached this device now", not
// "this number belongs to one person".

// Limits are env-tunable so testing isn't throttled while production stays
// strict. Defaults are the production-sane values; set OTP_* in .env to loosen
// for local dev (e.g. OTP_MAX_PER_HOUR=1000, OTP_RESEND_SECONDS=0).
const OTP_TTL_MS = 5 * 60 * 1000;        // code lifetime
const MAX_ATTEMPTS = 5;                    // wrong guesses before a code is dead
// Parse an int env var, allowing 0 (a plain `|| default` would wrongly treat 0
// as unset). Falls back to `def` only when the var is missing/invalid.
const envInt = (v, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const RESEND_WINDOW_MS = envInt(process.env.OTP_RESEND_SECONDS, 60) * 1000; // min gap between sends
const MAX_SENDS_PER_HOUR = envInt(process.env.OTP_MAX_PER_HOUR, 5);         // per phone, anti-abuse
const OTP_SECRET = process.env.OTP_SECRET || process.env.JWT_SECRET || 'dev_otp_secret';

function hashCode(phone, code) {
  // Bind the hash to the phone so a code is only valid for the number it was
  // issued to (and so identical codes for different phones don't collide).
  return crypto.createHmac('sha256', OTP_SECRET).update(`${phone}:${code}`).digest('hex');
}

// §8f — mask a name to initials for the pre-selection chooser. One SMS to a
// shared family number must not disclose the full names/ages/genders of everyone
// who ever registered under it. e.g. "Priya Sharma" -> "P. S.". The full identity
// is only revealed once the patient explicitly selects one (POST /reveal).
function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return parts.map((w) => w[0].toUpperCase() + '.').join(' ');
}

// Distinct prior PEOPLE who completed a visit on this phone, most-recent first.
// People are distinguished by name (case/space-insensitive) since one number may
// serve a whole family. The frontend turns this into the "who is this?" chooser.
async function priorPeople(phone) {
  const r = await pool.query(
    `SELECT name, age, gender, last_visit, visit_count FROM (
       SELECT DISTINCT ON (lower(trim(patient_name)))
         patient_name AS name, patient_age AS age, patient_gender AS gender,
         created_at AS last_visit,
         COUNT(*) OVER (PARTITION BY lower(trim(patient_name))) AS visit_count
       FROM sessions
       WHERE patient_phone = $1 AND state = 'COMPLETE' AND removed_at IS NULL
         AND patient_name IS NOT NULL AND trim(patient_name) <> ''
       ORDER BY lower(trim(patient_name)), created_at DESC
     ) q ORDER BY last_visit DESC
     LIMIT 20`,
    [phone]
  );
  return r.rows;
}

// POST /api/otp/request  { phone }  — generate + send a code for this session.
router.post('/request', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const { e164: phone, valid } = normalizeIndianPhone((req.body || {}).phone);
    if (!valid) return res.status(400).json({ error: 'Invalid phone number' });

    // In production, refuse to run without a real SMS provider — otherwise OTPs
    // are never delivered and the dev code would be exposed. Dev/dry-run is fine.
    if (process.env.NODE_ENV === 'production' && !smsConfigured()) {
      return res.status(503).json({ error: 'SMS delivery is not configured.' });
    }

    // The session this token points at must still exist — otherwise the OTP row's
    // FK to sessions would fail. (A session can vanish if the DB was reset between
    // scanning and verifying.) Return a clean "rescan" signal, not a 500.
    const sess = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [session_id]);
    if (!sess.rows.length) return res.status(440).json({ error: 'Session expired', session_expired: true });

    // Rate limit: not too often, and not too many per hour, per phone.
    const recent = await pool.query(
      `SELECT created_at FROM phone_otps
        WHERE phone = $1 AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC`,
      [phone]
    );
    if (recent.rows.length >= MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ error: 'Too many OTP requests. Please try again later.' });
    }
    if (recent.rows.length) {
      const sinceLast = Date.now() - new Date(recent.rows[0].created_at).getTime();
      if (sinceLast < RESEND_WINDOW_MS) {
        const wait = Math.ceil((RESEND_WINDOW_MS - sinceLast) / 1000);
        return res.status(429).json({ error: `Please wait ${wait}s before requesting another code.`, retry_after: wait });
      }
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await pool.query(
      `INSERT INTO phone_otps (phone, session_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [phone, session_id, hashCode(phone, code), expiresAt]
    );

    const body = `${code} is your verification code for your OPD pre-consultation. It is valid for 5 minutes. Do not share it.`;
    let delivery = { sent: false, dryRun: true };
    try {
      delivery = await sendSms(phone, body);
    } catch (err) {
      console.error('[otp] SMS send failed:', err.message);
      // Don't reveal provider internals; the row exists so verify still works in
      // dev/dry-run, and the patient can retry.
    }

    // Only ever expose the code when SMS isn't really configured (local/dev), so
    // the team can test end-to-end without a phone. Never in a configured setup.
    const payload = { sent: true, channel: 'sms', expires_in: OTP_TTL_MS / 1000 };
    if (!smsConfigured()) {
      payload.dev_mode = true;
      payload.dev_code = code; // visible only because no real SMS provider is set
    }
    res.json(payload);
  } catch (err) {
    console.error('otp request error:', err);
    sendServerError(res, err);
  }
});

// POST /api/otp/verify  { phone, code }  — check the code, mark session verified.
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const { e164: phone, valid } = normalizeIndianPhone((req.body || {}).phone);
    const code = String((req.body || {}).code || '').trim();
    if (!valid) return res.status(400).json({ error: 'Invalid phone number' });

    // Session must still exist (verify stamps phone_verified onto it).
    const sess = await pool.query('SELECT 1 FROM sessions WHERE id = $1', [session_id]);
    if (!sess.rows.length) return res.status(440).json({ error: 'Session expired', session_expired: true });
    if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'Enter the code sent to your phone' });

    // The active challenge: latest unverified, unexpired code for this phone.
    const r = await pool.query(
      `SELECT id, code_hash, attempts FROM phone_otps
        WHERE phone = $1 AND verified = false AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rows.length) {
      return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
    }
    const otp = r.rows[0];
    if (otp.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }

    const expected = Buffer.from(otp.code_hash);
    const got = Buffer.from(hashCode(phone, code));
    const ok = expected.length === got.length && crypto.timingSafeEqual(expected, got);
    if (!ok) {
      await pool.query('UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      const left = MAX_ATTEMPTS - (otp.attempts + 1);
      return res.status(401).json({ error: left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Incorrect code. Request a new one.' });
    }

    // Success: retire the code and stamp the session as phone-verified for this
    // exact number (register checks both).
    await pool.query('UPDATE phone_otps SET verified = true WHERE id = $1', [otp.id]);
    await pool.query(
      `UPDATE sessions SET patient_phone = $1, phone_verified = true, updated_at = NOW() WHERE id = $2`,
      [phone, session_id]
    );

    // Chooser shows the FULL name (product decision) so a patient can recognise
    // themselves easily. Age/gender are still withheld until the patient selects
    // one (POST /reveal) — so a shared number doesn't disclose everyone's full
    // demographics, only their names. `index` is the stable position in the
    // (deterministically ordered) list the reveal call re-derives.
    const people = (await priorPeople(phone)).map((p, i) => ({
      index: i,
      name: p.name,
      last_visit: p.last_visit,
      visit_count: p.visit_count,
    }));
    res.json({ verified: true, people });
  } catch (err) {
    console.error('otp verify error:', err);
    sendServerError(res, err);
  }
});

// POST /api/otp/reveal  { index }  — reveal the FULL identity of the prior person
// the patient selected from the masked chooser (§8f). Gated on the session being
// phone-verified; only ever returns ONE person (the chosen index), never the
// whole family. Re-derives the same deterministically-ordered list as /verify.
router.post('/reveal', authMiddleware, async (req, res) => {
  try {
    const { session_id } = req.session_data;
    const index = parseInt((req.body || {}).index, 10);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid selection' });
    }
    const sess = await pool.query(
      'SELECT patient_phone, phone_verified FROM sessions WHERE id = $1', [session_id]);
    if (!sess.rows.length) return res.status(440).json({ error: 'Session expired', session_expired: true });
    if (!sess.rows[0].phone_verified || !sess.rows[0].patient_phone) {
      return res.status(403).json({ error: 'Phone not verified' });
    }
    const people = await priorPeople(sess.rows[0].patient_phone);
    const p = people[index];
    if (!p) return res.status(404).json({ error: 'Selection not found' });
    res.json({ name: p.name, age: p.age, gender: p.gender });
  } catch (err) {
    console.error('otp reveal error:', err);
    sendServerError(res, err);
  }
});

module.exports = router;
