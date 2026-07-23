const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { signToken, authMiddleware, requireRole } = require('../middleware/auth');
const { isLocked, recordFailure, clearFailures } = require('../utils/loginLimiter');

const router = Router();

// Best-effort client IP for the shared-passcode login limiter (mirrors admin.js).
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// Nursing-station guard — the combined nurse / help-desk / social-worker station.
// 'admin' is allowed too so an admin can always see what the station sees.
const stationOnly = [authMiddleware, requireRole('staff', 'admin')];

// ── Station login ──
// Shared STAFF_PASSCODE + the operator's name (the name is carried in the token for
// the audit trail — same POC-grade shared-credential model as admin login). Fails
// closed if the passcode is unset/weak.
router.post('/login', async (req, res) => {
  try {
    const expected = (process.env.STAFF_PASSCODE || '').trim();
    if (!expected || expected.length < 6) {
      return res.status(503).json({ error: 'Nursing station login is not configured. Set a strong STAFF_PASSCODE.' });
    }
    // §8b — lockout on repeated failures from the same source.
    const ip = clientIp(req);
    const lock = await isLocked('staff', ip);
    if (lock.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfter / 60)} min.` });
    }
    const passcode = String((req.body || {}).passcode || '');
    if (!passcode) return res.status(400).json({ error: 'Passcode required' });
    const staffName = String((req.body || {}).staff_name || '').trim().slice(0, 80);
    if (staffName.length < 2) return res.status(400).json({ error: 'Enter your name' });

    // Constant-time comparison; unequal lengths => reject.
    const a = Buffer.from(passcode);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      await recordFailure('staff', ip);
      return res.status(401).json({ error: 'Invalid passcode' });
    }
    await clearFailures('staff', ip);

    const token = signToken({ role: 'staff', staff_name: staffName });
    try {
      await pool.query(
        `INSERT INTO audit_log (event_type, actor, payload) VALUES ('staff_login', $1, $2)`,
        [staffName, JSON.stringify({})]
      );
    } catch { /* audit_log optional */ }
    res.json({ success: true, data: { token } });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Active RED patients (pull side of the board) ──
// Every RED-triage patient from the last 24h not yet dispatched, removed, or
// acknowledged by the station. Token number + department ONLY — never the patient
// name: a help-desk/social worker shares this role, so we minimise to what locates
// the patient (the called token) and why to hurry (RED + wait time). This mirrors
// the DPDP reasoning on the public queue board, but here it is behind station auth.
router.get('/alerts', ...stationOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id,
              s.token_label,
              s.department,
              s.triage_level,
              (s.consulted_at IS NOT NULL) AS in_consult,
              ROUND(EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 60)::int AS waited_min
         FROM sessions s
        WHERE s.triage_level = 'RED'
          AND s.dispatched_at IS NULL
          AND s.removed_at IS NULL
          AND s.created_at > NOW() - INTERVAL '24 hours'
          AND NOT EXISTS (
            SELECT 1 FROM audit_log a
             WHERE a.event_type = 'staff_ack'
               AND a.payload->>'session_id' = s.id::text
               AND a.created_at > NOW() - INTERVAL '24 hours'
          )
        ORDER BY s.created_at ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Acknowledge a RED patient ──
// "I've got this." Records who/when to audit_log so the patient drops off every
// station's live list (the /alerts query filters acknowledged sessions). Advisory
// and non-clinical — it does not touch the session's triage or lifecycle.
router.post('/alerts/:id/ack', ...stationOnly, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const actor = (req.session_data && (req.session_data.staff_name || req.session_data.admin_name)) || 'staff';
    await pool.query(
      `INSERT INTO audit_log (event_type, actor, payload) VALUES ('staff_ack', $1, $2)`,
      [actor, JSON.stringify({ session_id: sessionId })]
    );
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
