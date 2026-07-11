/**
 * §6b — minimal MinIO client for the node backend, used ONLY to delete objects
 * during erasure/retention (the python backend owns uploads/reads via storage.py).
 * Mirrors that module's connection config so both talk to the same bucket.
 */
const Minio = require('minio');

let client = null;   // null = not initialised, false = unavailable
const BUCKET = process.env.MINIO_BUCKET || 'opd-documents';

function getClient() {
  if (client !== null) return client || null;
  try {
    client = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || 'minio',
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: false, // internal Docker network; matches storage.py secure=False
      accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
      secretKey: process.env.MINIO_SECRET_KEY || 'changeme_in_production',
    });
  } catch (err) {
    client = false;
    console.error('[minio] client init failed:', err.message);
    return null;
  }
  return client;
}

/**
 * Best-effort delete of a list of object keys. Never throws — returns the count
 * actually removed. A storage hiccup must not abort an erasure whose DB rows are
 * already gone (an orphaned object is a lesser evil than an un-erased record).
 */
async function deleteObjects(keys) {
  const c = getClient();
  if (!c || !keys || !keys.length) return 0;
  let removed = 0;
  for (const key of keys) {
    if (!key) continue;
    try {
      await c.removeObject(BUCKET, key);
      removed++;
    } catch (err) {
      console.error(`[minio] removeObject failed for a key (non-fatal): ${err.message}`);
    }
  }
  return removed;
}

module.exports = { deleteObjects };
