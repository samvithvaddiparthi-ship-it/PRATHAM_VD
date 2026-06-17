// Automatic, idempotent migration runner.
//
// Why this exists: Postgres only runs db/init.sh on a BRAND-NEW data volume, so
// teammates with an existing local DB never got new migrations — their backend
// then crashed querying columns that didn't exist (e.g. released_at). This runs
// on every backend startup, applies any *.sql in the migrations dir that hasn't
// been applied yet, and records it in schema_migrations.
//
// Safe to run against any DB: every migration file is idempotent
// (CREATE/ALTER ... IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING), so even
// re-running the full set on an already-initialised DB is a no-op.
const fs = require('fs');
const path = require('path');
const pool = require('./models/db');

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(__dirname, '../../../db/migrations');

async function runMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`[migrate] migrations dir not found at ${MIGRATIONS_DIR} — skipping`);
    return;
  }

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  const appliedRows = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.rows.map(r => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[migrate] FAILED on ${file}: ${err.message}`);
      throw err; // surface a real failure rather than starting a broken server
    } finally {
      client.release();
    }
  }
  console.log(count ? `[migrate] ${count} migration(s) applied` : '[migrate] up to date');
}

module.exports = { runMigrations };
