// Error tracking (Sentry) — scaffolded, OFF until SENTRY_DSN is set.
//
// Mentor decision 2026-07-20: cloud Sentry. This module initialises the Sentry SDK
// only when SENTRY_DSN is present, so with the DSN unset it is a strict no-op — no
// network, no overhead. Require it as the FIRST line of index.js so init runs before
// the rest of the app loads.
//
// PHI is never allowed to leave the process: send_default_pii is off and beforeSend
// strips request bodies, cookies and auth headers (patient names/phones/answers can
// live in any of those). We report the error's type/stack/location, not its data.
let Sentry = null;
let initialised = false;

// Fields that must never be shipped to a third party (health data / secrets).
function scrubEvent(event) {
  try {
    if (event.request) {
      // Request body / query can carry patient names, phone numbers, answers.
      delete event.request.data;
      delete event.request.cookies;
      delete event.request.query_string;
      if (event.request.headers) {
        for (const h of Object.keys(event.request.headers)) {
          if (/authorization|cookie|x-twilio-signature/i.test(h)) {
            event.request.headers[h] = '[redacted]';
          }
        }
      }
    }
    // We do not attach user identity; make sure nothing set it upstream.
    delete event.user;
  } catch { /* never let scrubbing throw */ }
  return event;
}

function init() {
  if (initialised) return;
  const dsn = (process.env.SENTRY_DSN || '').trim();
  if (!dsn) {
    // Scaffolded but disabled — the normal state until an operator sets a DSN.
    console.log('[error-tracking] disabled (set SENTRY_DSN to enable)');
    initialised = true;
    return;
  }
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      tracesSampleRate: 0,       // errors only — no performance tracing
      sendDefaultPii: false,     // never attach IP / cookies / user
      beforeSend: scrubEvent,
    });
    console.log('[error-tracking] Sentry initialised (errors only, PHI scrubbed)');
  } catch (err) {
    // Graceful degradation — a missing/broken SDK must never take the app down.
    Sentry = null;
    console.error('[error-tracking] Sentry init failed (continuing without it):', err.message);
  }
  initialised = true;
}

// Report a handled error. No-op when tracking is disabled.
function captureException(err, context) {
  if (!Sentry) return;
  try {
    Sentry.captureException(err, context ? { extra: { context } } : undefined);
  } catch { /* reporting must never break the request path */ }
}

// Initialise on require so this can be the first import in index.js.
init();

module.exports = { init, captureException };
