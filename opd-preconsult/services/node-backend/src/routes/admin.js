const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../models/db');
const { sendServerError } = require('../utils/http');
const { baseNodesForDept } = require('../seed/baseTemplate');
const { signToken, authMiddleware, requireRole } = require('../middleware/auth');
const { isLocked, recordFailure, clearFailures } = require('../utils/loginLimiter');
const { eraseSession } = require('../utils/erase');

const router = Router();

// Best-effort client IP for the shared-passcode login limiter (§8b). Behind the
// proxy the first X-Forwarded-For hop is the real client; falls back to the
// socket peer. Admin login is a single shared credential, so we throttle per
// source IP rather than per account.
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress || 'unknown';
}

// Admin-only guard for all mutating config routes below. GET (config reads) stay
// open — they expose department/question config, not patient PHI.
const adminOnly = [authMiddleware, requireRole('admin')];

// Draft → Publish (migration 031). The HIS editor never writes the published table
// directly; it writes a per-department DRAFT that only goes live on Publish. The
// patient engine (questionnaire.js / whatsapp.js) keeps reading Q_LIVE only.
// These names are whitelisted constants — never interpolate user input as a table.
const Q_LIVE = 'questionnaire_nodes';
const Q_DRAFT = 'questionnaire_nodes_draft';

// Is there an open (unpublished) draft for this department?
async function hasOpenDraft(db, department) {
  const r = await db.query('SELECT 1 FROM questionnaire_drafts WHERE department = $1', [department]);
  return r.rows.length > 0;
}

// Copy-on-write: the first time a department is edited, snapshot its published rows
// into the draft table and mark it dirty. The marker's PK makes this idempotent — a
// concurrent caller hits the conflict and skips the (would-be duplicate) copy.
async function ensureDraft(client, department) {
  const dept = String(department).toUpperCase();
  const marker = await client.query(
    'INSERT INTO questionnaire_drafts (department) VALUES ($1) ON CONFLICT (department) DO NOTHING RETURNING department',
    [dept]
  );
  if (marker.rows.length) {
    await client.query(`INSERT INTO ${Q_DRAFT} SELECT * FROM ${Q_LIVE} WHERE department = $1`, [dept]);
  }
  return dept;
}

// Which department does a question id belong to? Prefer the draft (the working copy
// once materialized), fall back to the published table.
async function nodeDepartment(db, id) {
  const r = await db.query(
    `SELECT department FROM ${Q_DRAFT} WHERE id = $1
     UNION ALL
     SELECT department FROM ${Q_LIVE} WHERE id = $1
     LIMIT 1`, [id]
  );
  return r.rows.length ? r.rows[0].department : null;
}

// ── Admin login ──
// Verifies the shared admin passcode (env ADMIN_PASSCODE) and issues an
// admin-role JWT for the HIS dashboard. POC-grade shared credential — per-user
// admin accounts / SSO is a later decision. Fails closed if not configured.
router.post('/login', async (req, res) => {
  try {
    const expected = (process.env.ADMIN_PASSCODE || '').trim();
    if (!expected || expected.length < 6) {
      return res.status(503).json({ error: 'Admin login is not configured. Set a strong ADMIN_PASSCODE.' });
    }
    // §8b — lockout on repeated failures from the same source.
    const ip = clientIp(req);
    const lock = await isLocked('admin', ip);
    if (lock.locked) {
      return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfter / 60)} min.` });
    }
    const passcode = String((req.body || {}).passcode || '');
    if (!passcode) return res.status(400).json({ error: 'Passcode required' });
    // Named-admin audit (A9): each admin identifies themselves so their actions are
    // attributable in audit_log. This is NOT a second credential — the passcode is
    // still the gate — just a label carried in the token for the audit trail.
    const adminName = String((req.body || {}).admin_name || '').trim().slice(0, 80);
    if (adminName.length < 2) return res.status(400).json({ error: 'Enter your name' });
    // Constant-time comparison (avoids timing leaks); unequal lengths => reject.
    const a = Buffer.from(passcode);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      await recordFailure('admin', ip);
      return res.status(401).json({ error: 'Invalid passcode' });
    }
    await clearFailures('admin', ip);

    const token = signToken({ role: 'admin', admin_name: adminName });
    try {
      await pool.query(
        `INSERT INTO audit_log (event_type, actor, payload) VALUES ('admin_login', $1, $2)`,
        [adminName, JSON.stringify({})]
      );
    } catch { /* audit_log optional */ }
    res.json({ token });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Right to erasure (DPDP §12) ──
// §6b — HARD-delete every PHI row for a session across all tables + the backing
// MinIO objects, leaving only a PHI-free tombstone in audit_log. Admin only, and
// irreversible — distinct from the doctor soft-remove (removed_at) which retains
// data. The global admin_action middleware also records who invoked it.
router.delete('/erase/:session_id', ...adminOnly, async (req, res) => {
  try {
    const result = await eraseSession(req.params.session_id, {
      actor: (req.session_data && req.session_data.admin_name) || 'admin',
      reason: 'manual_erasure',
    });
    if (!result.found) return res.status(404).json({ error: 'Session not found' });
    res.json({ erased: true, ...result });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Departments ──

// List departments
router.get('/departments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM departments ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet — return hardcoded defaults
    res.json([
      { code: 'CARD', name: 'Cardiology', is_active: true, collect_vitals: true },
      { code: 'GEN', name: 'General Medicine', is_active: true, collect_vitals: true },
    ]);
  }
});

// Create department
router.post('/departments', ...adminOnly, async (req, res) => {
  try {
    const { code, name, collect_vitals, icon } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const cleanCode = code.toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (cleanCode.length < 2) return res.status(400).json({ error: 'Code must be at least 2 characters (letters/numbers only)' });

    const result = await pool.query(
      'INSERT INTO departments (code, name, collect_vitals, icon) VALUES ($1, $2, $3, $4) RETURNING *',
      [cleanCode, name, collect_vitals === undefined ? true : !!collect_vitals, (icon || '').trim() || null]
    );

    // Seed the shared base intake questions for the new department so it starts
    // with the common template; DAG questions are added on top in HIS.
    for (const node of baseNodesForDept(cleanCode)) {
      await pool.query(
        `INSERT INTO questionnaire_nodes (id, department, text_en, text_hi, text_te, q_type, options_json, required, next_default, next_rules, sort_order, is_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [node.id, node.department, node.text_en, node.text_hi, node.text_te, node.q_type,
         node.options_json ? JSON.stringify(node.options_json) : null, node.required,
         node.next_default, node.next_rules, node.sort_order, true]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Department code already exists' });
    console.error('create department error:', err);
    sendServerError(res, err);
  }
});

// Update a department (name and/or the collect_vitals toggle). Only the provided
// fields are changed.
router.patch('/departments/:code', ...adminOnly, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { name, collect_vitals, icon, report_focus, is_active } = req.body;
    const sets = [];
    const params = [];

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(String(name).trim()); sets.push(`name = $${params.length}`);
    }
    if (is_active !== undefined) {
      // The reversible alternative to deletion, and the one migration 027 already
      // tells operators to reach for ("Deactivate it in HIS instead") — the column
      // existed but nothing could ever set it. Hides the department from the patient
      // picker while every visit, doctor and question stays exactly as it is.
      params.push(!!is_active); sets.push(`is_active = $${params.length}`);
    }
    if (collect_vitals !== undefined) {
      params.push(!!collect_vitals); sets.push(`collect_vitals = $${params.length}`);
    }
    if (icon !== undefined) {
      // Empty string clears the icon (falls back to the code-based guess).
      params.push(String(icon).trim() || null); sets.push(`icon = $${params.length}`);
    }
    if (report_focus !== undefined) {
      // Specialty-specific report emphasis (migration 029). Empty string clears it
      // → the report LLM uses the base prompt unchanged for this department.
      params.push(String(report_focus).trim() || null); sets.push(`report_focus = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(code);
    const result = await pool.query(
      `UPDATE departments SET ${sets.join(', ')} WHERE code = $${params.length} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Department not found' });
    res.json(result.rows[0]);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Delete department (only if no doctors, sessions, or questions reference it)
// What a delete would destroy. Drives the confirmation UI so the admin is told what
// they are about to lose BEFORE typing the code, not after a 409.
router.get('/departments/:code/impact', ...adminOnly, async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const dept = await pool.query('SELECT code FROM departments WHERE code = $1', [code]);
    if (!dept.rows.length) return res.status(404).json({ error: 'Department not found' });
    const counts = await pool.query(
      `SELECT (SELECT COUNT(*) FROM doctors            WHERE department = $1 AND is_active = true) AS doctors,
              (SELECT COUNT(*) FROM sessions           WHERE department = $1) AS sessions,
              (SELECT COUNT(*) FROM questionnaire_nodes WHERE department = $1) AS questions`,
      [code]
    );
    const r = counts.rows[0];
    res.json({
      code,
      doctors: parseInt(r.doctors),
      sessions: parseInt(r.sessions),
      questions: parseInt(r.questions),
      // Patient visits are clinical records. They are never collateral damage of a
      // config change — erasure is a separate, audited, per-session action
      // (utils/erase.js, DPDP). So sessions make deletion impossible, not merely
      // scary, and the admin is pointed at deactivation instead.
      deletable: parseInt(r.sessions) === 0,
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Delete a department.
//
//   plain       refuses if ANYTHING references it (doctors / sessions / questions).
//   ?force=1    additionally deletes its questions and deactivates its doctors.
//               Requires { confirm: "<CODE>" } in the body — checked HERE, not just
//               in the UI, so a stray scripted DELETE cannot wipe a department.
//
// Sessions block BOTH paths. Migration 027 set this precedent for the starter
// department ("if any patient session already chose OPD, keep everything") and the
// reasoning holds generally: department codes are loose strings with no FK, so
// deleting a department that visits reference strands those records — an in-progress
// interview loses the questionnaire nodes it is walking, and the queue board loses
// its heading. Deactivate instead: it hides the department from the patient picker
// while every visit stays intact.
router.delete('/departments/:code', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const code = req.params.code.toUpperCase();
    const force = req.query.force === '1' || req.query.force === 'true';

    const sessions = await client.query('SELECT COUNT(*) FROM sessions WHERE department = $1', [code]);
    const sessionCount = parseInt(sessions.rows[0].count);
    if (sessionCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${sessionCount} patient visit(s) reference this department. `
             + `Deactivate it instead — it disappears from the patient picker and the visits stay intact.`,
      });
    }

    const doctors = await client.query('SELECT COUNT(*) FROM doctors WHERE department = $1 AND is_active = true', [code]);
    const questions = await client.query('SELECT COUNT(*) FROM questionnaire_nodes WHERE department = $1', [code]);
    const doctorCount = parseInt(doctors.rows[0].count);
    const questionCount = parseInt(questions.rows[0].count);

    if (!force) {
      if (doctorCount > 0) {
        return res.status(409).json({ error: `Cannot delete: ${doctorCount} doctor(s) in this department` });
      }
      if (questionCount > 0) {
        return res.status(409).json({ error: `Cannot delete: ${questionCount} question(s) in this department. Delete them first.` });
      }
    } else if (String(req.body?.confirm || '').toUpperCase() !== code) {
      return res.status(400).json({ error: 'Confirmation does not match the department code' });
    }

    await client.query('BEGIN');
    if (force) {
      // Questions are configuration, regenerated from seed/HIS — safe to drop.
      await client.query('DELETE FROM questionnaire_nodes WHERE department = $1', [code]);
      // Drop any open draft for the department too, so a re-created department with
      // the same code does not inherit a stale draft.
      await client.query(`DELETE FROM ${Q_DRAFT} WHERE department = $1`, [code]);
      await client.query('DELETE FROM questionnaire_drafts WHERE department = $1', [code]);
      // Doctors are NOT deleted: the audit log and past visits reference them, and
      // doctors.department is NOT NULL so it cannot simply be cleared. Deactivating
      // keeps the record and the history while stopping the login, and an admin can
      // reactivate them into another department.
      await client.query('UPDATE doctors SET is_active = false WHERE department = $1', [code]);
    }
    const del = await client.query('DELETE FROM departments WHERE code = $1 RETURNING code', [code]);
    if (!del.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Department not found' });
    }
    await client.query('COMMIT');

    res.json({ deleted: true, questions_deleted: force ? questionCount : 0, doctors_deactivated: force ? doctorCount : 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

// ── Questions ──

// List questions for department — from the open draft if there is one, else the
// published set. Returns { questions, has_draft } so the editor can show the
// "unpublished changes" state and a Publish button.
router.get('/questions/:department', async (req, res) => {
  try {
    const dept = req.params.department.toUpperCase();
    const dirty = await hasOpenDraft(pool, dept);
    const result = await pool.query(
      `SELECT * FROM ${dirty ? Q_DRAFT : Q_LIVE} WHERE department = $1 ORDER BY sort_order`,
      [dept]
    );
    res.json({ questions: result.rows, has_draft: dirty });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Questionnaire editor helpers (Phase 1 intuitive editor) ----
// The clinician never types an id; it's slugged from the question text.
function slugifyId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'q';
}
const VALID_TRIAGE_FLAGS = ['RED', 'AMBER'];
// The discrete answer values a question can produce (Yes/No implicit for BOOLEAN).
function answerValues(q_type, options_json) {
  if (q_type === 'BOOLEAN') return ['yes', 'no'];
  if ((q_type === 'SINGLE_SELECT' || q_type === 'MULTI_SELECT') && Array.isArray(options_json)) {
    return options_json.map(o => (o && o.value != null ? String(o.value) : '')).filter(Boolean);
  }
  return [];
}
// Validate the triage config: every flag must be known and every trigger answer
// must be a real option — this closes the silent value-mismatch bug the old
// free-text had. Covers both the per-answer map (answer_triage) and the legacy
// single triage_flag/triage_answer pair.
function triageError({ triage_flag, triage_answer, answer_triage, q_type, options_json }) {
  const vals = answerValues(q_type, options_json);
  if (triage_flag) {
    if (!VALID_TRIAGE_FLAGS.includes(triage_flag)) return `Invalid urgency "${triage_flag}"`;
    if (!triage_answer) return 'An urgency flag needs the answer that triggers it';
    if (vals.length && !vals.includes(String(triage_answer))) {
      return `Urgency answer "${triage_answer}" is not one of this question's options`;
    }
  }
  if (answer_triage && typeof answer_triage === 'object' && !Array.isArray(answer_triage)) {
    for (const [ans, flag] of Object.entries(answer_triage)) {
      if (!VALID_TRIAGE_FLAGS.includes(flag)) return `Invalid urgency "${flag}" for answer "${ans}"`;
      if (vals.length && !vals.includes(String(ans))) {
        return `Urgency answer "${ans}" is not one of this question's options`;
      }
    }
  }
  return null;
}

// Create question (into the department's draft)
router.post('/questions', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id, department, text_en, text_hi, text_te, q_type, options_json, required,
            triage_flag, triage_answer, answer_triage, next_default, next_rules, sort_order, is_base } = req.body;

    if (!department || !text_en) return res.status(400).json({ error: 'Department and English text are required' });
    const tErr = triageError({ triage_flag, triage_answer, answer_triage, q_type, options_json });
    if (tErr) return res.status(400).json({ error: tErr });

    await client.query('BEGIN');
    const dept = await ensureDraft(client, department);

    // Auto-generate a stable id from the text, unique across BOTH the published and
    // draft tables so a later Publish can never collide on a primary key.
    let finalId = (id && String(id).trim()) || `q_${dept.toLowerCase()}_${slugifyId(text_en)}`;
    const taken = new Set((await client.query(
      `SELECT id FROM ${Q_LIVE} UNION SELECT id FROM ${Q_DRAFT}`)).rows.map(r => r.id));
    if (taken.has(finalId)) {
      let n = 2;
      while (taken.has(`${finalId}_${n}`)) n++;
      finalId = `${finalId}_${n}`;
    }

    const result = await client.query(
      `INSERT INTO ${Q_DRAFT} (id, department, text_en, text_hi, text_te, q_type, options_json, required, triage_flag, triage_answer, answer_triage, next_default, next_rules, sort_order, is_base)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [finalId, dept, text_en, text_hi || null, text_te || null, q_type,
       options_json ? JSON.stringify(options_json) : null,
       required !== false, triage_flag || null, triage_answer || null,
       answer_triage ? JSON.stringify(answer_triage) : null, next_default || null,
       next_rules ? JSON.stringify(next_rules) : null, sort_order || 0, is_base === true]
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

// Columns the editor may update — anything else in the body is ignored.
const EDITABLE_COLS = new Set(['department', 'text_en', 'text_hi', 'text_te', 'q_type',
  'options_json', 'required', 'triage_flag', 'triage_answer', 'answer_triage', 'next_default',
  'next_rules', 'sort_order', 'is_base', 'is_active', 'fhir_mapping']);

// Update question (in the department's draft)
router.put('/questions/:id', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const fields = req.body;
    const tErr = triageError({
      triage_flag: fields.triage_flag, triage_answer: fields.triage_answer,
      answer_triage: fields.answer_triage, q_type: fields.q_type, options_json: fields.options_json,
    });
    if (tErr) return res.status(400).json({ error: tErr });

    const JSON_COLS = new Set(['options_json', 'next_rules', 'answer_triage']);
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'id' || !EDITABLE_COLS.has(k)) continue;
      sets.push(`${k} = $${i}`);
      vals.push(JSON_COLS.has(k) ? (v == null ? null : JSON.stringify(v)) : v);
      i++;
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    await client.query('BEGIN');
    const dept = await nodeDepartment(client, req.params.id);
    if (!dept) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    await ensureDraft(client, dept);

    vals.push(req.params.id);
    const result = await client.query(
      `UPDATE ${Q_DRAFT} SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    await client.query('COMMIT');
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

// Delete question (from the department's draft)
router.delete('/questions/:id', ...adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dept = await nodeDepartment(client, req.params.id);
    if (dept) {
      await ensureDraft(client, dept);
      await client.query(`DELETE FROM ${Q_DRAFT} WHERE id = $1`, [req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

// Bulk sort-order update — powers the ↑/↓ reorder of base intake questions.
// Reorders happen within one department; the items carry that department's ids.
router.post('/questions/reorder', ...adminOnly, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No items to reorder' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dept = await nodeDepartment(client, items[0].id);
    if (!dept) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Question not found' }); }
    await ensureDraft(client, dept);
    for (const it of items) {
      await client.query(`UPDATE ${Q_DRAFT} SET sort_order = $1 WHERE id = $2`,
        [parseInt(it.sort_order) || 0, it.id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

// Publish a department's draft → the live questionnaire the patient engine reads.
// One transaction: replace the published rows with the draft, then clear the draft
// and its dirty marker. Safe no-op if there is no open draft.
router.post('/questions/publish', ...adminOnly, async (req, res) => {
  const department = String(req.body?.department || '').toUpperCase();
  if (!department) return res.status(400).json({ error: 'department required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const marker = await client.query('SELECT 1 FROM questionnaire_drafts WHERE department = $1', [department]);
    if (!marker.rows.length) {
      await client.query('ROLLBACK');
      return res.json({ published: false, reason: 'no draft' });
    }
    await client.query(`DELETE FROM ${Q_LIVE} WHERE department = $1`, [department]);
    await client.query(`INSERT INTO ${Q_LIVE} SELECT * FROM ${Q_DRAFT} WHERE department = $1`, [department]);
    await client.query(`DELETE FROM ${Q_DRAFT} WHERE department = $1`, [department]);
    await client.query('DELETE FROM questionnaire_drafts WHERE department = $1', [department]);
    await client.query('COMMIT');
    res.json({ published: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

// Discard a department's unpublished draft — the editor reverts to the live set.
router.post('/questions/discard', ...adminOnly, async (req, res) => {
  const department = String(req.body?.department || '').toUpperCase();
  if (!department) return res.status(400).json({ error: 'department required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${Q_DRAFT} WHERE department = $1`, [department]);
    await client.query('DELETE FROM questionnaire_drafts WHERE department = $1', [department]);
    await client.query('COMMIT');
    res.json({ discarded: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendServerError(res, err);
  } finally {
    client.release();
  }
});

module.exports = router;
