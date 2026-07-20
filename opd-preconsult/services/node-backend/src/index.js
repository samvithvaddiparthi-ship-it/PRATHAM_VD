// Error tracking first — initialises Sentry before the rest of the app loads (no-op
// unless SENTRY_DSN is set). See utils/errorTracking.js.
require('./utils/errorTracking');
const express = require('express');
const cors = require('cors');
const pool = require('./models/db');
const fs = require('fs');
const path = require('path');

const app = express();
// Trust the reverse proxy (Caddy/nginx) so req.protocol and forwarded headers
// reflect the real client — needed for Twilio signature URL reconstruction (§8a).
app.set('trust proxy', true);

// §7a — CORS. The app is same-origin (browser → gateway → backend), so cross-
// origin access is not needed in production. In prod we only allow the explicitly
// configured origins (CORS_ALLOW_ORIGINS, comma-separated); with none set, no
// permissive CORS header is emitted (same-origin only). Dev stays permissive.
const _corsOrigins = (process.env.CORS_ALLOW_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (process.env.NODE_ENV === 'production') {
  if (_corsOrigins.length) app.use(cors({ origin: _corsOrigins }));
  // else: no CORS middleware — browser same-origin policy applies.
} else {
  app.use(cors());
}
app.use(express.json({ limit: '20mb' }));
// Twilio posts webhooks as application/x-www-form-urlencoded — parse those too so
// the WhatsApp webhook body (and its signature validation) work (§8a).
app.use(express.urlencoded({ extended: false }));

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
app.use('/api/settings', require('./routes/settings'));
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
app.use('/api/tickets', require('./routes/tickets'));
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

    // 2) Department-specific DAG questions from seed files — DEMO CONTENT, off by
    //    default. Opt in with SEED_DEMO_QUESTIONS=true (local/testing only).
    //
    //    Off by default because these are demo questionnaires, and a real hospital
    //    would plausibly code its cardiology department `CARD` — which is all it
    //    takes for demo questions to be injected into a live department's intake.
    //    The `deptCodes` guard below is not enough on its own for that reason.
    //    Gating on env rather than diverging the code keeps this file byte-identical
    //    between here and the generated production repo: a difference that lives in
    //    configuration cannot drift, one that lives in a diff eventually will.
    //    Same intent as the demo doctors/departments split in migrations 005/006.
    const seedFiles = process.env.SEED_DEMO_QUESTIONS === 'true'
      ? { CARD: 'cardiology.json', GEN: 'general.json' }
      : {};
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

  // §8b — Pilot safety: no active doctor may use the seeded demo PIN (1234) in
  // production. Fail closed like JWT_SECRET: in production we FORCE-EXPIRE those
  // accounts (set is_active = false) so the weak PIN can't be used, and an admin
  // must re-activate them with a fresh PIN via HIS. In dev we only warn.
  //
  // Detection goes through verifyPin, one row at a time, because pin_hash holds
  // bcrypt — salted, so there is no fixed digest to match with a set-based
  // `WHERE pin_hash = $1`. A hash-equality check here would silently find nobody
  // and this guard would fail open.
  try {
    const pool = require('./models/db');
    const { verifyPin } = require('./utils/pinHash');
    const { rows } = await pool.query('SELECT id, pin_hash FROM doctors WHERE is_active = true');
    const demoIds = [];
    for (const r of rows) {
      if ((await verifyPin('1234', r.pin_hash)).ok) demoIds.push(r.id);
    }
    if (demoIds.length) {
      if (process.env.NODE_ENV === 'production') {
        await pool.query('UPDATE doctors SET is_active = false WHERE id = ANY($1::uuid[])', [demoIds]);
        console.error(`⚠️  [security] Force-expired ${demoIds.length} active doctor(s) still on the default demo PIN (1234). An admin must reset their PIN and re-activate them before they can log in.`);
      } else {
        console.warn(`[security] ${demoIds.length} active doctor(s) still use the default demo PIN (1234). Reset before real use.`);
      }
    }
  } catch { /* non-fatal — doctors table may not exist yet on a brand-new DB */ }

  app.listen(PORT, () => {
    console.log(`[node-backend] Running on port ${PORT}`);
  });

  // Start follow-up worker
  const { startFollowupWorker } = require('./workers/followup-worker');
  startFollowupWorker();

  // §6b — retention worker (hard-erases sessions older than RETENTION_DAYS).
  // No-op unless RETENTION_DAYS > 0.
  const { startRetentionWorker } = require('./workers/retention-worker');
  startRetentionWorker();
}

// Last-resort safety nets. Every route and worker has its own try/catch, so these
// only see what slips past — but since Node 15 an unhandled rejection terminates
// the process, and losing the backend drops every in-flight request plus the SSE
// alert stream for one stray promise. The two cases are NOT the same:
//
//  - unhandledRejection: a promise nobody awaited. The process is still sound, so
//    log it loudly and keep serving rather than vanishing mid-consultation.
//  - uncaughtException: the process may be in an undefined state. Serving on from
//    corrupt state is worse than a restart for a clinical tool, so exit and let the
//    supervisor bring us back clean (`restart: unless-stopped` in prod compose).
process.on('unhandledRejection', (reason) => {
  console.error('[node-backend] unhandled promise rejection (still serving):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[node-backend] uncaught exception — exiting for a clean restart:', err);
  process.exit(1);
});

start();
