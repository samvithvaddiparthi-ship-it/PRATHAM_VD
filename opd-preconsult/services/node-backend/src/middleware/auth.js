const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ── Signing key (fail closed) ────────────────────────────────────────────────
// Never run with a guessable signing key. Known placeholder/dev values are
// rejected so a misconfigured deploy can't silently issue forgeable tokens.
const WEAK_SECRETS = new Set([
  '', 'dev_secret', 'changeme', 'changeme_in_production',
  'changeme_in_production_use_256bit_random_string', 'your_key_here', 'secret',
]);

let JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const IS_PROD = process.env.NODE_ENV === 'production';
const secretIsWeak = WEAK_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 16;

if (secretIsWeak) {
  if (IS_PROD) {
    // Hard-fail in production: refuse to start without a strong secret.
    throw new Error(
      '[auth] JWT_SECRET is missing or weak. Set a strong random JWT_SECRET ' +
      '(>=16 chars, not the .env.example placeholder) before starting in production.'
    );
  }
  // Dev convenience: use a random ephemeral secret so the app still boots without
  // a static, guessable key. Tokens reset on each restart — set JWT_SECRET in .env
  // to persist sessions across restarts.
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[auth] No strong JWT_SECRET set — using a random ephemeral secret for this ' +
    'dev session (tokens reset on restart). Set JWT_SECRET in .env to persist.'
  );
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
}

// Verify a raw token against the resolved secret. Throws on invalid/expired —
// callers wrap in try/catch. Use this instead of jwt.verify with a literal
// fallback secret so every code path shares one (strong) signing key.
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token provided' });

  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  try {
    req.session_data = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Role gate — use AFTER authMiddleware. e.g. requireRole('admin') or
// requireRole('doctor', 'admin'). 403 if the token's role isn't allowed.
function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.session_data && req.session_data.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

// Ownership gate (§5c — horizontal IDOR). Use AFTER authMiddleware on routes that
// take a session id in the URL and are reachable by patients. Clinicians
// (doctor/admin) may read any session in their remit; a patient token is bound to
// exactly one session_id at issuance and may only touch that session's data. Any
// other combination (patient reading someone else's id, or a token with no
// session_id) is 403. Default param name is 'id'.
//
// Signing a token is not the same as being allowed to read the session named in
// the URL: POST /api/session/scan mints a token for anyone, so without this gate
// any valid token would read every patient's record.
//
// NOTE: doctors are deliberately NOT scoped to their own department here. The
// queue intentionally surfaces a patient's visits from other departments (see
// routes/doctor.js /queue) and reassignment moves patients across departments,
// so a department filter would break history. Narrowing clinical access further
// is a policy decision, not a code one.
function requireSessionOwnership(paramName = 'id') {
  return (req, res, next) => {
    const sd = req.session_data || {};
    if (sd.role === 'doctor' || sd.role === 'admin') return next();
    const requested = req.params[paramName];
    if (sd.role === 'patient' && sd.session_id && requested && sd.session_id === requested) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: not your session' });
  };
}

module.exports = { signToken, verifyToken, authMiddleware, requireRole, requireSessionOwnership };
