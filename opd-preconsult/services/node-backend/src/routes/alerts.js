const { Router } = require('express');
const { verifyToken } = require('../middleware/auth');

const router = Router();

// Connected SSE clients
const clients = new Set();

// SSE endpoint for nursing station alerts.
// §8e — EventSource can't send an Authorization header, so the clinician JWT is
// passed as ?token=<jwt> (the same short-lived login token used everywhere else)
// and verified here. doctor/admin and the nursing station (staff) may subscribe to
// the RED-triage feed. The payload is PHI-free by design (session_id + department +
// triage), so the station resolves nothing sensitive over the stream itself.
router.get('/stream', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  let sd;
  try {
    sd = verifyToken(String(token));
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  if (!sd || !['doctor', 'admin', 'staff'].includes(sd.role)) {
    return res.status(403).json({ error: 'Forbidden: insufficient role' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Broadcast alert to all connected SSE clients
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(msg);
  }
}

// Subscribe to Redis triage_alerts channel if available
function subscribeRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;

  try {
    const Redis = require('ioredis');
    const sub = new Redis(redisUrl);
    sub.subscribe('triage_alerts', (err) => {
      if (err) console.error('[alerts] Redis subscribe error:', err);
      else console.log('[alerts] Subscribed to triage_alerts channel');
    });
    sub.on('message', (channel, message) => {
      if (channel === 'triage_alerts') {
        try {
          const alert = JSON.parse(message);
          broadcast({ type: 'triage_alert', ...alert });
        } catch {}
      }
    });
  } catch (err) {
    console.log('[alerts] Redis not available for SSE alerts:', err.message);
  }
}

// Start Redis subscription on module load
subscribeRedis();

module.exports = router;
