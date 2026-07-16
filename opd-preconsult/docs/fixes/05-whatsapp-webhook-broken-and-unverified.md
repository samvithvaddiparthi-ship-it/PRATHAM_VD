# 05 — WhatsApp webhook never parses its body, and has no signature check

**Severity:** High · **Effort:** Medium
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/index.js`
- `services/node-backend/src/routes/whatsapp.js`
- `.env.example`

Nothing else.

## Problem A — the webhook has never worked

`services/node-backend/src/index.js` mounts exactly one body parser:

```js
app.use(express.json({ limit: '20mb' }));
```

Twilio posts webhooks as `application/x-www-form-urlencoded`, **not** JSON. So in
`services/node-backend/src/routes/whatsapp.js`:

```js
router.post('/webhook', async (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '');
  const body = (req.body.Body || '').trim();

  if (!from || !body) {
    return res.type('text/xml').send('<Response></Response>');
  }
```

`req.body` is always `{}`, `from` and `body` are always `''`, and the handler always
returns the empty `<Response></Response>`. The entire WhatsApp intake flow is dead
code that silently does nothing.

## Problem B — no request authentication

Twilio signs every webhook with `X-Twilio-Signature`. Nothing verifies it. Once
Problem A is fixed, anyone who can reach `/api/whatsapp/webhook` can drive the
conversation as **any phone number**: create sessions, register a patient name and
age, and write interview answers into the clinical record.

## Problem C — unbounded in-memory conversation map

```js
const waConversations = new Map();
```

Never evicted. Grows for the life of the process, and is lost on restart (a patient
mid-interview silently restarts). The restart behaviour is acceptable for now; the
unbounded growth is not.

## Decisions (already made — do not deviate)

1. **Mount `express.urlencoded()` only on the webhook route**, not globally. A
   global form parser would change the parsing behaviour of every other route for
   no reason.
2. **Verify the signature with Twilio's own helper**, `twilio.validateRequest`. The
   `twilio` package is already a dependency (used by `utils/sms.js` and the
   follow-up worker). Do not hand-roll the HMAC.
3. **Fail closed when `TWILIO_AUTH_TOKEN` is set.** If it is *not* set, the app is
   in dev/dry-run mode; log a loud warning once and allow the request, so local
   testing without Twilio credentials still works. In production the token is
   required, so this degrades safely.
4. **Reject with `403` and an empty body**, not a TwiML error message — an
   unverified caller gets nothing.
5. **Evict conversations after 30 minutes of inactivity**, checked lazily on each
   inbound message. Do not add a timer/interval.
6. Do **not** try to make the conversation map survive restarts. Out of scope.

## Required change

### 1. `index.js` — nothing to change globally

Leave `app.use(express.json(...))` exactly as it is. The form parser is mounted per
route in step 2.

### 2. `whatsapp.js`

Replace the top of the file (imports + map + webhook route) with:

```js
const { Router } = require('express');
const express = require('express');
const pool = require('../models/db');

const router = Router();

// Twilio posts webhooks as application/x-www-form-urlencoded, NOT JSON. The app
// only mounts express.json() globally, so without this parser req.body was always
// {} and this webhook silently did nothing. Mounted per-route so no other route's
// parsing behaviour changes.
const twilioBody = express.urlencoded({ extended: false });

// In-memory session tracking for WhatsApp conversations
// Maps phone number -> { session_id, state, department, current_question_id, last_seen }
const waConversations = new Map();

// Drop conversations nobody has touched in a while, so the map cannot grow without
// bound. Checked lazily on each inbound message — no timer.
const WA_CONVERSATION_TTL_MS = 30 * 60 * 1000;

function evictStaleConversations() {
  const cutoff = Date.now() - WA_CONVERSATION_TTL_MS;
  for (const [phone, conv] of waConversations) {
    if (!conv.last_seen || conv.last_seen < cutoff) waConversations.delete(phone);
  }
}

// Verify the request really came from Twilio. Twilio signs the exact URL it POSTed
// to plus the sorted form params with your account's auth token.
//
// Fails CLOSED when TWILIO_AUTH_TOKEN is set. When it is absent the deployment is in
// dev / dry-run mode (see utils/sms.js), so we warn once and allow — otherwise you
// could never exercise this locally.
let warnedNoToken = false;

function verifyTwilioSignature(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || token === 'your_token_here') {
    if (!warnedNoToken) {
      warnedNoToken = true;
      console.warn('[whatsapp] TWILIO_AUTH_TOKEN not set — webhook signature verification DISABLED (dev only).');
    }
    return next();
  }

  const twilio = require('twilio');
  const signature = req.headers['x-twilio-signature'];
  // Twilio signs the public URL. Behind nginx/Caddy the request looks like plain
  // http://node-backend:4001/... , so reconstruct the external URL from the proxy
  // headers. TWILIO_WEBHOOK_URL overrides it outright if the reconstruction is wrong.
  const url = process.env.TWILIO_WEBHOOK_URL
    || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}${req.originalUrl}`;

  if (!signature || !twilio.validateRequest(token, signature, url, req.body || {})) {
    console.warn('[whatsapp] rejected webhook: bad or missing X-Twilio-Signature');
    return res.status(403).end();
  }
  next();
}

// Twilio WhatsApp webhook — receives incoming messages
router.post('/webhook', twilioBody, verifyTwilioSignature, async (req, res) => {
  const from = (req.body.From || '').replace('whatsapp:', '');
  const body = (req.body.Body || '').trim();

  if (!from || !body) {
    return res.type('text/xml').send('<Response></Response>');
  }

  evictStaleConversations();

  try {
    const reply = await handleMessage(from, body);
    // Respond with TwiML
    const twiml = `<Response><Message>${escapeXml(reply)}</Message></Response>`;
    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[whatsapp] Error:', err);
    res.type('text/xml').send('<Response><Message>Sorry, something went wrong. Please try again.</Message></Response>');
  }
});
```

### 3. `whatsapp.js` — stamp `last_seen`

Every `waConversations.set(phone, ...)` must include `last_seen: Date.now()`. There
are five of them: in `startSession`, `chooseDepartment`, `registerName`,
`registerAge`, `registerGender`. For example:

```js
  waConversations.set(phone, { state: 'CHOOSE_DEPT', departments: depts, last_seen: Date.now() });
```

and

```js
  waConversations.set(phone, { ...conv, state: 'REGISTER_AGE', last_seen: Date.now() });
```

**Grep for `waConversations.set(` and confirm all five carry `last_seen`.**

### 4. `.env.example`

Under the existing Twilio block, add:

```bash
# Optional. The PUBLIC url Twilio POSTs the WhatsApp webhook to, e.g.
# https://opd.hospital.in/api/whatsapp/webhook . Only needed if the value the app
# reconstructs from X-Forwarded-Proto/Host does not match what you configured in
# the Twilio console — a mismatch makes signature verification fail.
# TWILIO_WEBHOOK_URL=
```

## Acceptance criteria

- [ ] `POST /api/whatsapp/webhook` with a form-encoded body and `TWILIO_AUTH_TOKEN`
      unset produces a real TwiML reply (department list), not `<Response></Response>`.
- [ ] With `TWILIO_AUTH_TOKEN` set and **no** `X-Twilio-Signature` header, the
      response is `403` with an empty body.
- [ ] With `TWILIO_AUTH_TOKEN` set and a **wrong** signature, the response is `403`.
- [ ] With `TWILIO_AUTH_TOKEN` set and a **valid** signature, the flow works.
- [ ] `express.json()` in `index.js` is unchanged, and no global `urlencoded` parser
      was added.
- [ ] All five `waConversations.set(...)` calls stamp `last_seen`.
- [ ] A conversation older than 30 minutes is dropped on the next inbound message.

## How to verify

```powershell
cd services\node-backend
node --check src\routes\whatsapp.js
```

Dev mode (no auth token) — must return the department list, proving the body now parses:

```powershell
docker compose exec node-backend sh -c "unset TWILIO_AUTH_TOKEN"  # or leave it unset in .env
curl.exe -s -X POST http://localhost/api/whatsapp/webhook `
  -H "Content-Type: application/x-www-form-urlencoded" `
  --data "From=whatsapp:%2B919876543210&Body=hi"
# expect <Response><Message>Welcome to OPD Pre-Consultation....
```

Signature enforcement — set `TWILIO_AUTH_TOKEN=testtoken123` in `.env`, restart, then:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://localhost/api/whatsapp/webhook `
  -H "Content-Type: application/x-www-form-urlencoded" `
  --data "From=whatsapp:%2B919876543210&Body=hi"
# expect 403

curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://localhost/api/whatsapp/webhook `
  -H "Content-Type: application/x-www-form-urlencoded" -H "X-Twilio-Signature: bogus" `
  --data "From=whatsapp:%2B919876543210&Body=hi"
# expect 403
```

To produce a **valid** signature for the positive case, compute it the way Twilio
does — full URL, then each form field appended in sorted key order:

```powershell
cd services\node-backend
node -e "const t=require('twilio');const url='http://localhost/api/whatsapp/webhook';const p={From:'whatsapp:+919876543210',Body:'hi'};console.log(t.getExpectedTwilioSignature('testtoken123',url,p));"
```

Pass that as `-H "X-Twilio-Signature: <value>"` and confirm you get TwiML back.
Note the URL must match exactly what the server reconstructs — set
`TWILIO_WEBHOOK_URL=http://localhost/api/whatsapp/webhook` while testing.

## Done when

The dev-mode call returns a department list (proving Problem A is fixed), the two
unsigned/bad-signature calls return `403`, the correctly-signed call returns TwiML,
and every `waConversations.set` stamps `last_seen`.
