// Centralised 500 responder: logs the real error server-side, returns a generic
// message so internals (stack traces, DB/driver details) never reach the client.
function sendServerError(res, err, context) {
  console.error('[server-error]' + (context ? ' ' + context : ''), err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { sendServerError };
