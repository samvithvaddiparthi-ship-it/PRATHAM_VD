const express = require('express');
const cors = require('cors');
const pool = require('./models/db');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Named-admin audit (A9): after any successful admin *mutation*, record WHO did it
// (the admin's name from their token) and WHAT. req.session_data is set by
// authMiddleware on the admin-gated routes and is still available when 'finish'
// fires. GETs and failed requests are skipped, so this is a low-noise action log.
app.use((req, res, next) => {
  res.on('finish', () => {
    const sd = req.session_data;
    if (sd && sd.role === 'admin' && req.method !== 'GET' && res.statusCode < 400) {
      pool.query(
        `INSERT INTO audit_log (event_type, actor, payload) VALUES ('admin_action', $1, $2)`,
        [sd.admin_name || 'admin', JSON.stringify({ method: req.method, path: req.originalUrl, status: res.statusCode })]
      ).catch(() => {});
    }
  });
  next();
});

// Routes
app.use('/api/session', require('./routes/session'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/otp', require('./routes/otp'));
app.use('/api/q', require('./routes/questionnaire'));
app.use('/api/vitals', require('./routes/vitals'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/protocol', require('./routes/protocol'));
app.use('/api/alerts', require('./routes/alerts'));
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/prescription', require('./routes/prescription'));
app.use('/api/followup', require('./routes/followup'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/his', require('./routes/mock-his'));

// Seed questionnaire data on startup.
//   - Every department gets the shared BASE intake questions (visit type,
//     progress, chief complaint, current medicines, allergies) from one template.
//   - Departments with a seed file (CARD, GEN) additionally get their own
//     department-specific DAG questions.
async function seedQuestionnaires() {
  try {
    const total = parseInt((await pool.query('SELECT COUNT(*) FROM questionnaire_nodes')).rows[0].count);
    const baseCount = parseInt((await pool.query('SELECT COUNT(*) FROM questionnaire_nodes WHERE is_base = true')).rows[0].count);

    if (total > 0 && baseCount > 0) {
      console.log('[seed] Questionnaire nodes already use base/DAG structure, skipping seed');
      return;
    }
    if (total > 0 && baseCount === 0) {
      // Pre-base structure (common questions duplicated per department). Re-seed
      // into the base/DAG layout. questionnaire_nodes is configuration (no FK
      // dependents, regenerated from seed files), so this is safe — not patient data.
      await pool.query('TRUNCATE questionnaire_nodes');
      console.log('[seed] Old questionnaire structure detected — re-seeding with base/DAG template');
    }

    const { baseNodesForDept } = require('./seed/baseTemplate');

    async function insertNode(node) {
      await pool.query(
        `INSERT INTO questionnaire_nodes (id, department, text_en, text_hi, text_te, q_type, options_json, required, triage_flag, triage_answer, next_default, next_rules, sort_order, is_base)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [node.id, node.department, node.text_en, node.text_hi || null, node.text_te || null,
         node.q_type, node.options_json ? JSON.stringify(node.options_json) : null,
         node.required !== false, node.triage_flag || null, node.triage_answer || null,
         node.next_default || null, node.next_rules ? JSON.stringify(node.next_rules) : null,
         node.sort_order || 0, node.is_base === true]
      );
    }

    // 1) Base intake questions for every department that EXISTS in the table.
    //    No demo fallback: a blank install (no departments) seeds nothing, so a
    //    clean hospital deployment stays clean and a wipe survives restarts.
    //    Creating a department in HIS seeds its base questions (routes/admin.js).
    let deptCodes = [];
    try {
      const d = await pool.query('SELECT code FROM departments');
      deptCodes = d.rows.map(r => r.code);
    } catch { /* departments table may not exist yet */ }
    if (deptCodes.length === 0) {
      console.log('[seed] No departments present — skipping questionnaire seed (clean install)');
      return;
    }

    for (const code of deptCodes) {
      for (const node of baseNodesForDept(code)) await insertNode(node);
    }
    console.log(`[seed] Base questions seeded for: ${deptCodes.join(', ')}`);

    // 2) Department-specific DAG questions from seed files — ONLY for departments
    //    that actually exist, so a blank install never resurrects demo content.
    const seedFiles = { CARD: 'cardiology.json', GEN: 'general.json' };
    for (const [code, file] of Object.entries(seedFiles)) {
      if (!deptCodes.includes(code)) continue;
      const filePath = path.join(__dirname, 'seed', file);
      const nodes = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const node of nodes) await insertNode(node);
      console.log(`[seed] Loaded ${nodes.length} DAG nodes from ${file}`);
    }
  } catch (err) {
    console.error('[seed] Error seeding questionnaires:', err);
  }
}

const PORT = process.env.PORT || 4001;

async function start() {
  // Wait briefly for DB to be ready
  let retries = 10;
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      retries--;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Apply any pending DB migrations BEFORE serving — so a pulled schema change
  // never crashes a teammate's existing DB (it auto-applies on startup).
  try {
    const { runMigrations } = require('./migrate');
    await runMigrations();
  } catch (err) {
    console.error('[migrate] migration run failed:', err.message);
  }

  await seedQuestionnaires();

  // Pilot safety: warn loudly if any active doctor still uses the seeded demo
  // PIN (1234) in production. Reset via POST /api/doctor/change-pin or HIS doctor
  // management before going live. (Forcing a reset needs a schema flag — deferred.)
  try {
    const DEFAULT_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';
    const pool = require('./models/db');
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM doctors WHERE is_active = true AND pin_hash = $1',
      [DEFAULT_PIN_HASH]
    );
    if (rows[0].n > 0) {
      const msg = `[security] ${rows[0].n} active doctor(s) still use the default demo PIN (1234). Reset before real use.`;
      if (process.env.NODE_ENV === 'production') console.error('⚠️  ' + msg);
      else console.warn(msg);
    }
  } catch { /* non-fatal — doctors table may not exist yet on a brand-new DB */ }

  app.listen(PORT, () => {
    console.log(`[node-backend] Running on port ${PORT}`);
  });

  // Start follow-up worker
  const { startFollowupWorker } = require('./workers/followup-worker');
  startFollowupWorker();
}

start();
