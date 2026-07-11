/**
 * §8b — brute-force protection for credential logins (doctor PIN, admin passcode).
 *
 * Redis-backed sliding failure counter keyed per identifier. After
 * LOGIN_MAX_ATTEMPTS failures inside LOGIN_LOCKOUT_SECONDS the identifier is
 * locked out until the window expires; a successful login clears the counter.
 *
 * Redis is already in the stack (SSE alerts, triage). If it is unavailable we
 * fail OPEN (no lockout) rather than deny all logins — losing brute-force
 * protection is preferable to an outage that locks every clinician out. This is
 * logged so the degraded state is visible.
 */
const Redis = require('ioredis');

const MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS || '5', 10);
const WINDOW_SECONDS = parseInt(process.env.LOGIN_LOCKOUT_SECONDS || '900', 10); // 15 min

let client = null; // null = not initialised, false = unavailable

function getRedis() {
  if (client !== null) return client || null;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = false;
    console.warn('[login-limiter] REDIS_URL unset — login rate limiting disabled (fail open).');
    return null;
  }
  try {
    client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
    client.on('error', () => { /* handled per-call; avoid unhandled error crash */ });
  } catch {
    client = false;
    console.warn('[login-limiter] Redis init failed — login rate limiting disabled (fail open).');
    return null;
  }
  return client;
}

function keyFor(kind, identifier) {
  return `login:fail:${kind}:${identifier}`;
}

// Returns { locked: boolean, retryAfter: seconds } — locked when the identifier
// has already exhausted its attempts inside the window.
async function isLocked(kind, identifier) {
  const r = getRedis();
  if (!r) return { locked: false, retryAfter: 0 };
  try {
    const key = keyFor(kind, identifier);
    const n = parseInt((await r.get(key)) || '0', 10);
    if (n < MAX_ATTEMPTS) return { locked: false, retryAfter: 0 };
    const ttl = await r.ttl(key);
    return { locked: true, retryAfter: ttl > 0 ? ttl : WINDOW_SECONDS };
  } catch {
    return { locked: false, retryAfter: 0 };
  }
}

// Record one failed attempt; sets the window TTL on the first failure.
async function recordFailure(kind, identifier) {
  const r = getRedis();
  if (!r) return;
  try {
    const key = keyFor(kind, identifier);
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, WINDOW_SECONDS);
  } catch { /* fail open */ }
}

// Clear the counter after a successful login.
async function clearFailures(kind, identifier) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(keyFor(kind, identifier));
  } catch { /* fail open */ }
}

module.exports = { isLocked, recordFailure, clearFailures, MAX_ATTEMPTS, WINDOW_SECONDS };
