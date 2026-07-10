const { Router } = require('express');
const crypto = require('crypto');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = Router();
const receivedBundles = [];

// Shared bearer token for the HIS webhook receiver. The pushing service (not the
// browser) authenticates with it. Fails closed when unset: an unauthenticated
// receiver lets anyone inject FHIR bundles — and read them back below.
const WEBHOOK_TOKEN = (process.env.HIS_WEBHOOK_TOKEN || '').trim();

function webhookAuth(req, res, next) {
  if (!WEBHOOK_TOKEN) {
    return res.status(503).json({ error: 'HIS webhook is not configured' });
  }
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : header;
  const a = Buffer.from(presented);
  const b = Buffer.from(WEBHOOK_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Invalid webhook token' });
  }
  next();
}

// Receive a FHIR bundle. Bundles carry full patient identity, so both the write
// and the read below are gated — this receiver is reachable from the public edge
// (the gateway routes /his/fhir; the single-container nginx routes all of /his/).
router.post('/fhir/bundle', webhookAuth, (req, res) => {
  const bundle = req.body;
  receivedBundles.push({
    received_at: new Date().toISOString(),
    bundle,
  });
  res.json({ status: 'accepted', id: receivedBundles.length });
});

// Dashboard data — every bundle ever pushed, i.e. bulk PHI. Admin only.
router.get('/dashboard', authMiddleware, requireRole('admin'), (req, res) => {
  res.json(receivedBundles);
});

module.exports = router;
