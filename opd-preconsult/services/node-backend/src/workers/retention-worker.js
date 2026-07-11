/**
 * §6b — Retention worker. Periodically hard-erases sessions older than
 * RETENTION_DAYS (env). DISABLED by default (RETENTION_DAYS unset or 0) so no data
 * is ever deleted unless an operator opts in. Mirrors the followup-worker
 * setInterval pattern. Erasure itself (DB rows + MinIO objects + tombstone) is in
 * utils/erase.js — shared with the admin erase endpoint.
 */
const pool = require('../models/db');
const { eraseSession } = require('../utils/erase');

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '0', 10);
const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const BATCH = 50;                        // cap work per tick

async function purgeExpired() {
  if (!(RETENTION_DAYS > 0)) return; // disabled
  try {
    const { rows } = await pool.query(
      `SELECT id FROM sessions WHERE created_at < NOW() - make_interval(days => $1) ORDER BY created_at LIMIT $2`,
      [RETENTION_DAYS, BATCH]
    );
    if (!rows.length) return;
    let erased = 0;
    for (const r of rows) {
      try {
        await eraseSession(r.id, { actor: 'retention-worker', reason: 'retention' });
        erased++;
      } catch (err) {
        console.error(`[retention] erase failed for a session (non-fatal): ${err.message}`);
      }
    }
    console.log(`[retention] erased ${erased}/${rows.length} session(s) older than ${RETENTION_DAYS} day(s)`);
  } catch (err) {
    console.error('[retention] purge error:', err.message);
  }
}

function startRetentionWorker() {
  if (!(RETENTION_DAYS > 0)) {
    console.log('[retention] disabled (set RETENTION_DAYS > 0 to enable hard erasure of old sessions)');
    return;
  }
  console.log(`[retention] starting — erasing sessions older than ${RETENTION_DAYS} day(s), every 6h`);
  setTimeout(purgeExpired, 30000);        // first pass shortly after boot
  setInterval(purgeExpired, INTERVAL_MS);
}

module.exports = { startRetentionWorker };
