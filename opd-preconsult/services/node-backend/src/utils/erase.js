/**
 * §6b — DPDP right-to-erasure: HARD-delete every PHI row for a session across all
 * tables enumerated in the gap analysis, delete the backing MinIO objects, and
 * leave a PHI-free tombstone in audit_log. Used by BOTH the admin erase endpoint
 * and the retention worker.
 *
 * Unit of erasure is a SESSION (this system has no separate patient entity —
 * identity is name+phone across sessions). Session-keyed data is always removed;
 * phone-keyed clinical history (patient_allergies) is removed only when this was
 * the phone's LAST remaining session, so erasing one visit among many does not
 * wipe a returning patient's (or a family member's) allergy record.
 */
const pool = require('../models/db');
const { deleteObjects } = require('./minioClient');

async function eraseSession(sessionId, { actor = 'admin', reason = 'manual' } = {}) {
  // 1) Collect MinIO object keys + the session's phone BEFORE deleting anything.
  const sess = await pool.query('SELECT patient_phone FROM sessions WHERE id = $1', [sessionId]);
  if (!sess.rows.length) return { found: false };
  const phone = sess.rows[0].patient_phone;

  const docKeys = await pool.query(
    'SELECT storage_key, image_key FROM session_documents WHERE session_id = $1', [sessionId]);
  const audKeys = await pool.query(
    'SELECT object_key FROM answer_audio WHERE session_id = $1', [sessionId]);
  const keys = [];
  for (const d of docKeys.rows) { if (d.storage_key) keys.push(d.storage_key); if (d.image_key) keys.push(d.image_key); }
  for (const a of audKeys.rows) { if (a.object_key) keys.push(a.object_key); }

  // 2) Delete all DB rows in one transaction (children before parent, FK-safe).
  const client = await pool.connect();
  let allergiesDeleted = 0;
  const counts = {};
  try {
    await client.query('BEGIN');
    const del = async (label, sql, params) => {
      const r = await client.query(sql, params);
      counts[label] = r.rowCount;
    };
    // prescription_items cascades from prescriptions (ON DELETE CASCADE).
    await del('prescriptions', 'DELETE FROM prescriptions WHERE session_id = $1', [sessionId]);
    await del('scheduled_followups', 'DELETE FROM scheduled_followups WHERE session_id = $1', [sessionId]);
    await del('protocol_sessions', 'DELETE FROM protocol_sessions WHERE session_id = $1', [sessionId]);
    await del('answer_audio', 'DELETE FROM answer_audio WHERE session_id = $1', [sessionId]);
    await del('session_reports', 'DELETE FROM session_reports WHERE session_id = $1', [sessionId]);
    await del('session_vitals', 'DELETE FROM session_vitals WHERE session_id = $1', [sessionId]);
    await del('session_answers', 'DELETE FROM session_answers WHERE session_id = $1', [sessionId]);
    await del('session_documents', 'DELETE FROM session_documents WHERE session_id = $1', [sessionId]);
    await del('phone_otps', 'DELETE FROM phone_otps WHERE session_id = $1', [sessionId]);

    // Phone-keyed history: only when no OTHER session survives for this phone.
    if (phone) {
      const others = await client.query(
        'SELECT 1 FROM sessions WHERE patient_phone = $1 AND id <> $2 LIMIT 1', [phone, sessionId]);
      if (!others.rows.length) {
        const a = await client.query('DELETE FROM patient_allergies WHERE patient_phone = $1', [phone]);
        allergiesDeleted = a.rowCount;
        await client.query('DELETE FROM phone_otps WHERE phone = $1', [phone]);
      }
    }

    await del('sessions', 'DELETE FROM sessions WHERE id = $1', [sessionId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // 3) Delete MinIO objects AFTER the DB commit (best-effort; orphaned objects are
  //    a lesser evil than un-erased rows). Then write the PHI-free tombstone.
  const objectsDeleted = await deleteObjects(keys);

  try {
    await pool.query(
      `INSERT INTO audit_log (session_id, event_type, actor, payload) VALUES ($1, 'patient_erased', $2, $3)`,
      [sessionId, String(actor), JSON.stringify({
        reason, objects_deleted: objectsDeleted, allergies_deleted: allergiesDeleted, rows: counts,
      })]
    );
  } catch { /* tombstone is best-effort; erasure already succeeded */ }

  return { found: true, objectsDeleted, allergiesDeleted, rows: counts };
}

module.exports = { eraseSession };
