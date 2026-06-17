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

// Routes
app.use('/api/session', require('./routes/session'));
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

// Seed questionnaire data on startup
async function seedQuestionnaires() {
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM questionnaire_nodes');
    if (parseInt(existing.rows[0].count) > 0) {
      console.log('[seed] Questionnaire nodes already exist, skipping seed');
      return;
    }

    const seedFiles = ['cardiology.json', 'general.json'];
    for (const file of seedFiles) {
      const filePath = path.join(__dirname, 'seed', file);
      const nodes = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const node of nodes) {
        await pool.query(
          `INSERT INTO questionnaire_nodes (id, department, text_en, text_hi, text_te, q_type, options_json, required, triage_flag, triage_answer, next_default, next_rules, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO NOTHING`,
          [node.id, node.department, node.text_en, node.text_hi || null, node.text_te || null,
           node.q_type, node.options_json ? JSON.stringify(node.options_json) : null,
           node.required !== false, node.triage_flag || null, node.triage_answer || null,
           node.next_default || null, node.next_rules ? JSON.stringify(node.next_rules) : null,
           node.sort_order || 0]
        );
      }
      console.log(`[seed] Loaded ${nodes.length} nodes from ${file}`);
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

  app.listen(PORT, () => {
    console.log(`[node-backend] Running on port ${PORT}`);
  });

  // Start follow-up worker
  const { startFollowupWorker } = require('./workers/followup-worker');
  startFollowupWorker();
}

start();
