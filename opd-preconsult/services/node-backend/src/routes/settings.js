const { Router } = require('express');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = Router();

// Admin-only guard for the mutating route below.
const adminOnly = [authMiddleware, requireRole('admin')];

// Booleans are stored as the text 'true' / 'false' in app_settings.value.
function boolValue(rows, key, fallback) {
  const row = rows.find((r) => r.key === key);
  if (!row) return fallback;
  return row.value === 'true';
}

// PUBLIC read — the patient flow needs to know whether to show the document/OCR
// step, and this exposes only non-sensitive feature flags (no PHI, no secrets).
// Defaults OCR to ON if the row is somehow missing, matching the seeded value.
router.get('/public', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM app_settings`);
    res.json({ ocr_enabled: boolValue(rows, 'ocr_enabled', true) });
  } catch (err) {
    // Fail OPEN (OCR on) so a settings glitch never silently drops the document
    // step — an admin can always turn it back off.
    console.error('settings public read failed:', err);
    res.json({ ocr_enabled: true });
  }
});

// ADMIN read — full settings for the HIS dashboard toggle.
router.get('/', adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value, updated_at, updated_by FROM app_settings`);
    res.json({ ocr_enabled: boolValue(rows, 'ocr_enabled', true) });
  } catch (err) {
    sendServerError(res, err, 'settings admin read');
  }
});

// ADMIN write — currently the global OCR on/off flag. Hospital-wide (not
// per-department for now). Upserts the key and records who changed it.
router.put('/', adminOnly, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.ocr_enabled !== 'boolean') {
      return res.status(400).json({ error: 'ocr_enabled (boolean) required' });
    }
    const adminName = (req.session_data && req.session_data.admin_name) || 'admin';
    const value = body.ocr_enabled ? 'true' : 'false';
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ('ocr_enabled', $1, NOW(), $2)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW(), updated_by = $2`,
      [value, adminName]
    );
    try {
      await pool.query(
        `INSERT INTO audit_log (event_type, actor, payload) VALUES ('setting_changed', $1, $2)`,
        [adminName, JSON.stringify({ key: 'ocr_enabled', value })]
      );
    } catch { /* audit_log optional */ }
    res.json({ ocr_enabled: body.ocr_enabled });
  } catch (err) {
    sendServerError(res, err, 'settings admin write');
  }
});

module.exports = router;
