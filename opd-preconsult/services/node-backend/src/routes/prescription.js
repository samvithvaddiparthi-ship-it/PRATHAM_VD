const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../models/db');
const { authMiddleware, requireRole, requireSessionOwnership } = require('../middleware/auth');
const { sendServerError } = require('../utils/http');
const { mergeRxTemplate } = require('../rxTemplate');

const router = Router();

// ── Hospital prescription template (branding/theme/toggles) ──
// GET is public — the patient-facing digital prescription page renders with it.
router.get('/template', async (req, res) => {
  try {
    const r = await pool.query("SELECT config FROM rx_template WHERE hospital_id = 'default'");
    res.json(mergeRxTemplate(r.rows[0]?.config));
  } catch (err) {
    res.json(mergeRxTemplate(null));   // defaults if the table isn't there yet
  }
});

// Save the template (admin only).
router.put('/template', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const config = mergeRxTemplate(req.body || {});   // validate/normalise against defaults
    await pool.query(
      `INSERT INTO rx_template (hospital_id, config, updated_at)
       VALUES ('default', $1, NOW())
       ON CONFLICT (hospital_id) DO UPDATE SET config = $1, updated_at = NOW()`,
      [JSON.stringify(config)]
    );
    res.json(config);
  } catch (err) {
    console.error('save rx template error:', err);
    sendServerError(res, err);
  }
});

const QR_SECRET = (process.env.QR_SIGNING_SECRET || 'changeme_qr_secret').trim();
// A weak/default HMAC key makes prescription QR slips forgeable. Fail closed in
// production (mirrors the JWT_SECRET guard in middleware/auth.js); warn in dev.
const QR_SECRET_WEAK =
  QR_SECRET === 'changeme_qr_secret' || QR_SECRET === 'your_key_here' || QR_SECRET.length < 16;
if (QR_SECRET_WEAK) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[prescription] QR_SIGNING_SECRET is missing or weak. Set a strong random ' +
      'QR_SIGNING_SECRET (>=16 chars, not the .env.example placeholder) before starting in production.'
    );
  }
  console.warn('[prescription] WARNING: QR_SIGNING_SECRET is weak/default. Set a strong, secret QR_SIGNING_SECRET before any real use — QR prescriptions are otherwise forgeable.');
}

// Sign a payload for the prescription QR (full HMAC-SHA256, hex).
function signPayload(payload) {
  return crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex');
}

// §8d — QR payload version and configurable expiry. v2 drops patient_phone from
// the slip (a durable identifier the pharmacy doesn't need) and is expiry-checked
// against issued_at. Default 30 days; QR_EXPIRY_DAYS=0 disables the expiry check.
const QR_PAYLOAD_VERSION = 2;
const QR_EXPIRY_DAYS = (() => {
  const n = parseInt(process.env.QR_EXPIRY_DAYS, 10);
  return Number.isFinite(n) ? n : 30;
})();

// Create prescription (doctor auth required)
router.post('/', authMiddleware, requireRole('doctor'), async (req, res) => {
  try {
    const doctorId = req.session_data.doctor_id;
    if (!doctorId) return res.status(403).json({ error: 'Doctor auth required' });

    const { session_id, items, notes } = req.body;
    // Advice-only consultations are allowed — a prescription may have zero drugs
    // (guidance/notes only). Only session_id is strictly required.
    const rxItems = Array.isArray(items) ? items : [];
    if (!session_id) {
      return res.status(400).json({ error: 'session_id required' });
    }

    // Patient identity from the session (signed into the payload so the digital
    // Rx shows the same details — which the template may optionally display).
    const session = await pool.query(
      'SELECT patient_phone, patient_name, patient_age, patient_gender, assigned_doctor_id FROM sessions WHERE id = $1', [session_id]);
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    // Ownership: don't let a doctor prescribe for a patient assigned to ANOTHER
    // doctor (wrong-prescriber attribution). Unassigned/own is allowed — the normal
    // flow opens (self-assigns) the patient before prescribing.
    const assignedTo = session.rows[0].assigned_doctor_id;
    if (assignedTo && assignedTo !== doctorId) {
      return res.status(403).json({ error: 'This patient is assigned to another doctor' });
    }
    const patientPhone = session.rows[0].patient_phone;
    const patientName = session.rows[0].patient_name;
    const patientAge = session.rows[0].patient_age;
    const patientGender = session.rows[0].patient_gender;

    // Prescribing doctor — included in the signed payload so the digital Rx can
    // show who authorised it. registration_no is pulled LIVE here, so editing the
    // doctor's record flows through to subsequent prescriptions.
    const docRow = await pool.query('SELECT name, department, registration_no FROM doctors WHERE id = $1', [doctorId]);
    const doctorName = docRow.rows[0]?.name || null;
    const doctorDept = docRow.rows[0]?.department || null;
    const doctorReg = docRow.rows[0]?.registration_no || null;

    // Create prescription
    const rxResult = await pool.query(
      `INSERT INTO prescriptions (session_id, doctor_id, patient_phone, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [session_id, doctorId, patientPhone, notes || null]
    );
    const rx = rxResult.rows[0];

    // Insert items
    const insertedItems = [];
    for (const item of rxItems) {
      const result = await pool.query(
        `INSERT INTO prescription_items (prescription_id, drug_name, dose, frequency, duration, instructions, warnings)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [rx.id, item.drug_name, item.dose || null, item.frequency || null,
         item.duration || null, item.instructions || null,
         item.warnings ? JSON.stringify(item.warnings) : null]
      );
      insertedItems.push(result.rows[0]);
    }

    // Generate QR payload. §8d: v2 — patient_phone is NOT embedded (the pharmacy
    // needs name/age/gender to dispense, not the durable phone identifier), and
    // issued_at is signed so verify-qr can enforce an expiry window.
    const issuedAt = new Date().toISOString();
    const qrData = {
      v: QR_PAYLOAD_VERSION,
      rx_id: rx.id,
      patient: patientName,
      patient_age: patientAge,
      patient_gender: patientGender,
      doctor: doctorName,
      doctor_registration: doctorReg,
      department: doctorDept,
      items: rxItems.map(i => ({
        drug: i.drug_name,
        dose: i.dose,
        freq: i.frequency,
        duration: i.duration,
        instructions: i.instructions || null,
      })),
      notes: notes || null,
      date: issuedAt.slice(0, 10),
      issued_at: issuedAt,
    };
    const payload = JSON.stringify(qrData);
    const signature = signPayload(payload);
    const qrPayload = Buffer.from(JSON.stringify({ ...qrData, sig: signature })).toString('base64');

    await pool.query('UPDATE prescriptions SET qr_payload = $1 WHERE id = $2', [qrPayload, rx.id]);

    // §6a — PHI-free audit of prescription creation (ids + counts only).
    try {
      await pool.query(
        `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'prescription_created', $2, $3)`,
        [session_id, String(doctorId), JSON.stringify({ rx_id: rx.id, item_count: insertedItems.length })]
      );
    } catch { /* audit_log optional */ }

    res.json({ prescription: { ...rx, qr_payload: qrPayload }, items: insertedItems, issued_at: issuedAt });
  } catch (err) {
    console.error('create prescription error:', err);
    sendServerError(res, err);
  }
});

// Get prescriptions for a session — the patient's own digital prescription page
// reads this, so a patient may view their OWN; clinicians may view any (§5c).
router.get('/session/:session_id', authMiddleware, requireSessionOwnership('session_id'), async (req, res) => {
  try {
    const rxs = await pool.query(
      'SELECT p.*, d.name as doctor_name FROM prescriptions p LEFT JOIN doctors d ON p.doctor_id = d.id WHERE p.session_id = $1 ORDER BY p.created_at DESC',
      [req.params.session_id]
    );

    const result = [];
    for (const rx of rxs.rows) {
      const items = await pool.query(
        'SELECT * FROM prescription_items WHERE prescription_id = $1 ORDER BY created_at',
        [rx.id]
      );
      result.push({ ...rx, items: items.rows });
    }
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

// §6a — PHI-free audit of a QR verification (ids + result only; actor unknown as
// the verify endpoint is unauthenticated pharmacy-facing).
async function auditQr(rxId, result) {
  try {
    await pool.query(
      `INSERT INTO audit_log (event_type, actor, payload) VALUES ('qr_verified', 'pharmacy', $1)`,
      [JSON.stringify({ rx_id: rxId || null, result })]
    );
  } catch { /* audit_log optional */ }
}

// Verify QR prescription
router.post('/verify-qr', async (req, res) => {
  try {
    const { qr_payload } = req.body;
    if (!qr_payload) return res.status(400).json({ error: 'qr_payload required' });

    const decoded = JSON.parse(Buffer.from(qr_payload, 'base64').toString());
    const { sig, ...data } = decoded;
    const expected = signPayload(JSON.stringify(data));

    // Constant-time signature compare (unequal lengths => reject).
    const a = Buffer.from(String(sig || ''));
    const b = Buffer.from(expected);
    const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!sigOk) {
      await auditQr(data.rx_id, 'invalid_signature');
      return res.json({ valid: false, error: 'Invalid signature' });
    }

    // §8d — reject a slip past its expiry window (signed issued_at). Backward
    // compatible: a legacy payload without issued_at skips the check.
    if (QR_EXPIRY_DAYS > 0 && data.issued_at) {
      const ageMs = Date.now() - new Date(data.issued_at).getTime();
      if (Number.isFinite(ageMs) && ageMs > QR_EXPIRY_DAYS * 86400000) {
        await auditQr(data.rx_id, 'expired');
        return res.json({ valid: false, error: 'Prescription expired', expired: true });
      }
    }

    await auditQr(data.rx_id, 'valid');
    res.json({ valid: true, prescription: data });
  } catch (err) {
    res.json({ valid: false, error: 'Invalid QR data' });
  }
});

// Patient allergies — list for a phone. Phone-addressable clinical history:
// clinicians only (§5a).
router.get('/allergies/:phone', authMiddleware, requireRole('doctor', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM patient_allergies WHERE patient_phone = $1 ORDER BY created_at',
      [req.params.phone]
    );
    res.json(result.rows);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Add allergy — writes clinical history against an arbitrary phone (§5a).
router.post('/allergies', authMiddleware, requireRole('doctor', 'admin'), async (req, res) => {
  try {
    const { patient_phone, allergen, reaction_type, severity, source } = req.body;
    if (!patient_phone || !allergen) {
      return res.status(400).json({ error: 'patient_phone and allergen required' });
    }
    const result = await pool.query(
      `INSERT INTO patient_allergies (patient_phone, allergen, reaction_type, severity, source)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [patient_phone, allergen, reaction_type || null, severity || 'unknown', source || 'doctor_entered']
    );
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

module.exports = router;
