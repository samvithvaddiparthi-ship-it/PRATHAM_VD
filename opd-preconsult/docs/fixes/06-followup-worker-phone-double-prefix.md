# 06 — Follow-up worker builds `whatsapp:+91+91...`

**Severity:** Medium · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/workers/followup-worker.js`
- `services/node-backend/src/routes/followup.js`

Nothing else.

## The problem

Every phone number in this system is stored in E.164 form (`+919876543210`).
`services/node-backend/src/routes/otp.js` normalises with `normalizeIndianPhone`
before writing `sessions.patient_phone`:

```js
    await pool.query(
      `UPDATE sessions SET patient_phone = $1, phone_verified = true, updated_at = NOW() WHERE id = $2`,
      [phone, session_id]
    );
```

But `services/node-backend/src/workers/followup-worker.js` prepends the country code
again:

```js
          const toNumber = followup.channel === 'sms'
            ? followup.patient_phone
            : `whatsapp:+91${followup.patient_phone}`;
```

which yields `whatsapp:+91+919876543210`. Twilio rejects it.

`channel` defaults to `'whatsapp'` in `services/node-backend/src/routes/followup.js`:

```js
      [session_id, protocol_id || null, patient_phone, message, send_at, channel || 'whatsapp']
```

so this is the default path. It is latent only because no frontend code calls
`api.createFollowup` yet — the moment anyone wires up the follow-up UI, every
WhatsApp follow-up fails.

Secondary issue: `POST /api/followup` accepts `patient_phone` verbatim from the
request body with no normalisation, so a caller can insert a non-E.164 number and
the worker will happily try to send to it.

## Decisions (already made — do not deviate)

1. **E.164 is the single storage format.** The worker must not add a country code.
   Prefix only the `whatsapp:` scheme.
2. **Normalise at the write boundary**, in `POST /api/followup`, using the existing
   `normalizeIndianPhone` from `utils/phone.js`. Reject an invalid number with `400`.
   Do not normalise inside the worker — by then it is too late to tell the caller.
3. **Do not add a data migration** to fix existing rows. `scheduled_followups` has
   no rows in any real deployment (nothing creates them). If you find rows, leave
   them; the normalisation guard stops new bad ones.
4. Keep the existing dry-run behaviour (no Twilio client → log and mark sent).

## Required change

### 1. `workers/followup-worker.js`

Replace:

```js
          const fromNumber = followup.channel === 'sms'
            ? process.env.TWILIO_SMS_FROM
            : process.env.TWILIO_WHATSAPP_FROM;
          const toNumber = followup.channel === 'sms'
            ? followup.patient_phone
            : `whatsapp:+91${followup.patient_phone}`;
```

with:

```js
          const fromNumber = followup.channel === 'sms'
            ? process.env.TWILIO_SMS_FROM
            : process.env.TWILIO_WHATSAPP_FROM;
          // patient_phone is already E.164 (+91XXXXXXXXXX) — normalizeIndianPhone
          // guarantees it at every write. Only the channel scheme is prepended;
          // re-adding +91 here produced 'whatsapp:+91+919876543210'.
          const toNumber = followup.channel === 'sms'
            ? followup.patient_phone
            : `whatsapp:${followup.patient_phone}`;
```

### 2. `routes/followup.js`

Add the import at the top:

```js
const { normalizeIndianPhone } = require('../utils/phone');
```

In `router.post('/', ...)`, replace:

```js
    const { session_id, protocol_id, patient_phone, message, send_at, channel } = req.body;
    if (!session_id || !patient_phone || !message || !send_at) {
      return res.status(400).json({ error: 'session_id, patient_phone, message, and send_at required' });
    }
    const result = await pool.query(
      `INSERT INTO scheduled_followups (session_id, protocol_id, patient_phone, message, send_at, channel)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [session_id, protocol_id || null, patient_phone, message, send_at, channel || 'whatsapp']
    );
```

with:

```js
    const { session_id, protocol_id, patient_phone, message, send_at, channel } = req.body;
    if (!session_id || !patient_phone || !message || !send_at) {
      return res.status(400).json({ error: 'session_id, patient_phone, message, and send_at required' });
    }
    // Store E.164 only. The worker prepends just the channel scheme, so a number
    // written in any other shape would be dispatched malformed.
    const { e164, valid } = normalizeIndianPhone(patient_phone);
    if (!valid) return res.status(400).json({ error: 'Invalid phone number' });

    const ch = channel || 'whatsapp';
    if (ch !== 'whatsapp' && ch !== 'sms') {
      return res.status(400).json({ error: "channel must be 'whatsapp' or 'sms'" });
    }

    const result = await pool.query(
      `INSERT INTO scheduled_followups (session_id, protocol_id, patient_phone, message, send_at, channel)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [session_id, protocol_id || null, e164, message, send_at, ch]
    );
```

## Acceptance criteria

- [ ] The worker never contains the literal `+91` .
- [ ] `POST /api/followup` with `"patient_phone":"9876543210"` stores `+919876543210`.
- [ ] `POST /api/followup` with `"patient_phone":"12345"` returns `400`.
- [ ] `POST /api/followup` with `"channel":"telegram"` returns `400`.
- [ ] A due WhatsApp follow-up in dry-run mode logs a masked number and marks the
      row `sent` (existing behaviour, unchanged).
- [ ] `POST /api/followup` still requires a doctor/admin token (it is already gated —
      **do not remove that gate**).

## How to verify

```powershell
cd services\node-backend
node --check src\workers\followup-worker.js
node --check src\routes\followup.js
Select-String -Path src\workers\followup-worker.js -Pattern '\+91'
# must produce no matches other than inside a comment
```

With the stack up and a doctor token in `$d`:

```powershell
# valid -> 200, and the stored number is E.164
Invoke-RestMethod -Method Post -Uri http://localhost/api/followup `
  -Headers @{ Authorization = "Bearer $d" } -ContentType 'application/json' `
  -Body '{"session_id":"<any real session uuid>","patient_phone":"9876543210","message":"test","send_at":"2020-01-01T00:00:00Z"}'

docker compose exec postgres psql -U opd_user -d opd_preconsult -c `
  "SELECT patient_phone, channel FROM scheduled_followups ORDER BY created_at DESC LIMIT 1;"
# expect +919876543210 | whatsapp

# invalid -> 400
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://localhost/api/followup `
  -H "Authorization: Bearer $d" -H "Content-Type: application/json" `
  --data '{"session_id":"x","patient_phone":"12345","message":"m","send_at":"2020-01-01T00:00:00Z"}'
# expect 400
```

`send_at` in the past means the worker picks it up within 5 minutes (or 10 seconds
after a restart). Watch the log:

```powershell
docker compose logs -f node-backend | Select-String "followup-worker"
# expect: (dry-run) Would send whatsapp to ***10 (4 chars)
```

Delete the test row afterwards.

## Done when

`Select-String` finds no live `+91` in the worker, the stored number is E.164, the
invalid-number and invalid-channel calls return `400`, and the dry-run log line
appears.
