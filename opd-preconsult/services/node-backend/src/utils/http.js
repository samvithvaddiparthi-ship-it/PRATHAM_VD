const { captureException } = require('./errorTracking');

// Centralised 500 responder: logs the real error server-side, returns a generic
// message so internals (stack traces, DB/driver details) never reach the client.
// This is the funnel every route's catch block uses, so it is also where handled
// errors are reported to Sentry (no-op unless SENTRY_DSN is set).
function sendServerError(res, err, context) {
  console.error('[server-error]' + (context ? ' ' + context : ''), err);
  captureException(err, context);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { sendServerError };
