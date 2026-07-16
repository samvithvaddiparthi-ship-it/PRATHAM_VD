/**
 * Doctor PIN hashing.
 *
 * PINs were stored as UNSALTED SHA-256 — a fast, unsalted hash means anyone who
 * gets a copy of the doctors table can recover every PIN instantly (a 4-digit
 * space is only 10k values; one precomputed SHA-256 table reverses all of them
 * at once, and two doctors with the same PIN are visibly identical).
 *
 * We now store bcrypt hashes (salted + deliberately slow), so a leaked table
 * can't be reversed in bulk. Existing SHA-256 hashes still verify once and are
 * transparently upgraded to bcrypt on the next successful login (lazy migration),
 * so nobody has to reset their PIN.
 *
 * NOTE: bcrypt raises the bar but a 4-digit PIN is still low-entropy — pair this
 * with the login lockout (utils/loginLimiter.js) and consider longer PINs.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const ROUNDS = 10;

// Legacy unsalted SHA-256 → 64 lowercase hex chars.
function legacySha256(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function isLegacyHash(stored) {
  return typeof stored === 'string' && /^[a-f0-9]{64}$/i.test(stored);
}

// Hash a PIN for storage (bcrypt).
async function hashPin(pin) {
  return bcrypt.hash(String(pin), ROUNDS);
}

// Verify a PIN against a stored hash. Handles both bcrypt and the legacy
// SHA-256 so pre-migration doctors keep working. Returns { ok, needsRehash };
// needsRehash is true when a legacy hash matched, signalling the caller to
// re-store it as bcrypt.
async function verifyPin(pin, stored) {
  if (!stored) return { ok: false, needsRehash: false };
  if (isLegacyHash(stored)) {
    return { ok: legacySha256(pin) === stored, needsRehash: legacySha256(pin) === stored };
  }
  try {
    return { ok: await bcrypt.compare(String(pin), stored), needsRehash: false };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

module.exports = { hashPin, verifyPin };
