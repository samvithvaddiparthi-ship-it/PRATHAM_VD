/**
 * Browser error intake — the frontend half of error tracking.
 *
 * WHY THIS EXISTS RATHER THAN @sentry/nextjs:
 *   The official SDK ships the DSN to the browser (NEXT_PUBLIC_*) and posts events
 *   from the patient's device straight to Sentry. That means a third-party origin
 *   receives traffic from every patient handset, and the DSN is public. Routing
 *   reports through our own backend keeps the DSN server-side, keeps the browser
 *   talking only to the hospital's own domain, and reuses the PHI scrubbing that
 *   already guards the backend events (utils/errorTracking.js).
 *
 * PHI RULE: a browser error can carry patient data in the most ordinary way — a
 * React render error quoting a field value, a URL with a name in the query string.
 * So this endpoint is deliberately narrow: it accepts a fixed, small set of fields,
 * truncates each hard, strips query strings from the URL, and never trusts the
 * client to have scrubbed anything. Anything not on the allow-list is dropped.
 *
 * It is unauthenticated by necessity — errors happen before login and on the public
 * intake screens — so it is bounded at the gateway (rate limit) and here (body size,
 * field count, truncation).
 */
const express = require('express');
const { captureException } = require('../utils/errorTracking');

const router = express.Router();

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_FIELD = 200;

// Keep only the shape of a location, never its parameters — a query string is a
// classic accidental PHI carrier (?name=, ?phone=, ?session=).
function safePath(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return new URL(value, 'http://x').pathname.slice(0, MAX_FIELD);
  } catch {
    return String(value).split('?')[0].slice(0, MAX_FIELD);
  }
}

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

router.post('/', express.json({ limit: '16kb' }), (req, res) => {
  try {
    const body = req.body || {};
    const message = str(body.message, MAX_MESSAGE);
    if (!message) {
      // Nothing useful to report — accept quietly so the browser never retries.
      return res.json({ success: true });
    }

    const err = new Error(message);
    err.name = str(body.name, 100) || 'ClientError';
    err.stack = str(body.stack, MAX_STACK) || undefined;

    captureException(err, {
      source: 'browser',
      path: safePath(body.path),
      // A coarse UA string is useful for reproducing and carries no patient data.
      userAgent: str(req.get('user-agent'), MAX_FIELD),
      kind: str(body.kind, 40),
    });

    res.json({ success: true });
  } catch (err) {
    // Reporting an error must never itself become an error the user sees.
    res.json({ success: true });
  }
});

module.exports = router;
