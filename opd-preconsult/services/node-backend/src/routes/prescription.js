const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { sendServerError } = require('../utils/http');

const router = Router();

const QR_SECRET = process.env.DEMO_QR_SECRET || 'changeme_qr_secret';
if (QR_SECRET === 'changeme_qr_secret') {
  console.warn('[prescription] WARNING: DEMO_QR_SECRET is the default value. Set a strong, secret DEMO_QR_SECRET before any real use — QR prescriptions are otherwise forgeable.');
}

// Sign a payload for the prescription QR (full HMAC-SHA256, hex).
function signPayload(payload) {
  return crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex');
}

// Create prescription (doctor auth required)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const doctorId = req.session_data.doctor_id;
    if (!doctorId) return res.status(403).json({ error: 'Doctor auth required' });

    const { session_id, items, notes } = req.body;
    if (!session_id || !items || !items.length) {
      return res.status(400).json({ error: 'session_id and items required' });
    }

    // Get patient phone from session
    const session = await pool.query('SELECT patient_phone, patient_name FROM sessions WHERE id = $1', [session_id]);
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    const patientPhone = session.rows[0].patient_phone;
    const patientName = session.rows[0].patient_name;

    // Prescribing doctor — included in the signed payload so the digital Rx can
    // show who authorised it (kept in sync with the printed slip).
    const docRow = await pool.query('SELECT name, department FROM doctors WHERE id = $1', [doctorId]);
    const doctorName = docRow.rows[0]?.name || null;
    const doctorDept = docRow.rows[0]?.department || null;

    // Create prescription
    const rxResult = await pool.query(
      `INSERT INTO prescriptions (session_id, doctor_id, patient_phone, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [session_id, doctorId, patientPhone, notes || null]
    );
    const rx = rxResult.rows[0];

    // Insert items
    const insertedItems = [];
    for (const item of items) {
      const result = await pool.query(
        `INSERT INTO prescription_items (prescription_id, drug_name, dose, frequency, duration, instructions, warnings)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [rx.id, item.drug_name, item.dose || null, item.frequency || null,
         item.duration || null, item.instructions || null,
         item.warnings ? JSON.stringify(item.warnings) : null]
      );
      insertedItems.push(result.rows[0]);
    }

    // Generate QR payload
    const issuedAt = new Date().toISOString();
    const qrData = {
      rx_id: rx.id,
      patient: patientName,
      doctor: doctorName,
      department: doctorDept,
      items: items.map(i => ({
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

    res.json({ prescription: { ...rx, qr_payload: qrPayload }, items: insertedItems, issued_at: issuedAt });
  } catch (err) {
    console.error('create prescription error:', err);
    sendServerError(res, err);
  }
});

// Get prescriptions for a session
router.get('/session/:session_id', async (req, res) => {
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

// Verify QR prescription
router.post('/verify-qr', async (req, res) => {
  try {
    const { qr_payload } = req.body;
    if (!qr_payload) return res.status(400).json({ error: 'qr_payload required' });

    const decoded = JSON.parse(Buffer.from(qr_payload, 'base64').toString());
    const { sig, ...data } = decoded;
    const expected = signPayload(JSON.stringify(data));

    if (sig !== expected) {
      return res.json({ valid: false, error: 'Invalid signature' });
    }

    res.json({ valid: true, prescription: data });
  } catch (err) {
    res.json({ valid: false, error: 'Invalid QR data' });
  }
});

// Patient allergies — list for a phone
router.get('/allergies/:phone', async (req, res) => {
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

// Add allergy
router.post('/allergies', async (req, res) => {
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
