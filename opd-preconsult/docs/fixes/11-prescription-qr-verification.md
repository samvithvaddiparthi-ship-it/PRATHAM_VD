# 11 — QR verify: timing-unsafe compare, and never consults the database

**Severity:** Medium · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/routes/prescription.js`

Nothing else. **No migration** — `prescriptions.status` already exists
(`VARCHAR(32) DEFAULT 'active'`).

## The problem

`services/node-backend/src/routes/prescription.js`:

```js
// Verify QR prescription
router.post('/verify-qr', async (req, res) => {
  try {
    const { qr_payload } = req.body;
    if (!qr_payload) return res.status(400).json({ error: 'qr_payload required' });

    const decoded = JSON.parse(Buffer.from(qr_payload, 'base64').toString());
    const { sig, ...data } = decoded;
    const expected = signPayload(JSON.stringify(data));

    if (sig !== expected) {
      return res.json({ valid: false, error: 'Invalid signature' });
    }

    res.json({ valid: true, prescription: data });
  } catch (err) {
    res.json({ valid: false, error: 'Invalid QR data' });
  }
});
```

**A — `sig !== expected` is not constant-time.** String comparison short-circuits on
the first differing character, leaking the correct HMAC byte-by-byte to an attacker who
can time responses. The rest of this codebase already knows this: `admin.js` uses
`crypto.timingSafeEqual` for the passcode, `otp.js` for the OTP hash. This one was missed.

**B — the endpoint never touches the database.** It validates the HMAC and returns the
decoded payload. A prescription that was cancelled, superseded, or whose row was deleted
still verifies as `valid: true` at the pharmacy counter, forever. The signature proves
*"this slip was issued by us"*, not *"this slip is currently dispensable"*.

## Decisions (already made — do not deviate)

1. **Compare with `crypto.timingSafeEqual`.** Guard the length first — `timingSafeEqual`
   throws on unequal buffer lengths.
2. **Look the prescription up by `rx_id`** and require the row to exist. A signed slip
   whose row is gone is `valid: false`.
3. **Require `status = 'active'`.** Anything else is `valid: false` with an explicit
   reason. This makes revocation possible later without another release.
4. **Report the failure reason distinctly** (`invalid_signature`, `not_found`, `revoked`)
   so the pharmacy UI can tell "forged" from "cancelled". Keep returning HTTP `200` with
   `valid: false` — the existing frontend at `frontend/src/app/rx/verify/page.jsx` relies
   on that shape. **Do not switch to a 4xx status.**
5. Keep the endpoint **unauthenticated**. A pharmacist scanning a slip has no login.
   That is intended.
6. Do **not** add a `revoked_at` column or a revoke endpoint. Out of scope — `status`
   already exists and is enough.

## Required change

Replace the whole `verify-qr` route with:

```js
// Verify QR prescription. Public by design — a pharmacist scanning a slip has no login.
//
// Two independent checks:
//   1. the HMAC proves WE issued this slip (it wasn't forged or edited), and
//   2. the DB lookup proves the prescription still EXISTS and is still dispensable.
// The signature alone can never expire, so (2) is what makes cancellation possible.
router.post('/verify-qr', async (req, res) => {
  try {
    const { qr_payload } = req.body;
    if (!qr_payload) return res.status(400).json({ error: 'qr_payload required' });

    const decoded = JSON.parse(Buffer.from(qr_payload, 'base64').toString());
    const { sig, ...data } = decoded;

    // Constant-time: a plain !== leaks the expected HMAC byte-by-byte to a caller
    // who can time the response. Matches the comparisons in admin.js / otp.js.
    const expected = Buffer.from(signPayload(JSON.stringify(data)));
    const got = Buffer.from(String(sig || ''));
    const signatureOk = expected.length === got.length && crypto.timingSafeEqual(expected, got);
    if (!signatureOk) {
      return res.json({ valid: false, reason: 'invalid_signature', error: 'Invalid signature' });
    }

    if (!data.rx_id) {
      return res.json({ valid: false, reason: 'invalid_signature', error: 'Invalid signature' });
    }

    const rx = await pool.query('SELECT id, status FROM prescriptions WHERE id = $1', [data.rx_id]);
    if (!rx.rows.length) {
      return res.json({ valid: false, reason: 'not_found', error: 'Prescription not found' });
    }
    if (rx.rows[0].status !== 'active') {
      return res.json({ valid: false, reason: 'revoked', error: `Prescription is ${rx.rows[0].status}` });
    }

    res.json({ valid: true, prescription: data });
  } catch (err) {
    res.json({ valid: false, reason: 'malformed', error: 'Invalid QR data' });
  }
});
```

`crypto` and `pool` are already imported at the top of the file. Do not re-import them.

## Why `rx_id` is checked before the DB call

`signPayload` runs over whatever object came out of the QR. A payload with no `rx_id`
that somehow passed the HMAC (i.e. was legitimately issued by us) is still nonsense to
look up. Treating it as an invalid signature keeps the failure modes to a fixed set and
avoids `SELECT ... WHERE id = undefined` reaching Postgres as a type error.

## Acceptance criteria

- [ ] `sig !== expected` no longer appears; `crypto.timingSafeEqual` is used.
- [ ] Length is checked before `timingSafeEqual` (it throws otherwise).
- [ ] A valid slip for an `active` prescription returns `{ valid: true, prescription: {...} }`.
- [ ] A valid slip whose `prescriptions` row was deleted returns
      `{ valid: false, reason: 'not_found' }`.
- [ ] A valid slip whose row has `status <> 'active'` returns
      `{ valid: false, reason: 'revoked' }`.
- [ ] A tampered payload returns `{ valid: false, reason: 'invalid_signature' }`.
- [ ] Every response is HTTP `200`. The route is still unauthenticated.
- [ ] `frontend/src/app/rx/verify/page.jsx` still renders correctly for all four cases
      (it keys off `valid`; the new `reason` field is additive).

## How to verify

```powershell
cd services\node-backend
node --check src\routes\prescription.js
Select-String -Path src\routes\prescription.js -Pattern 'sig !== expected'
# must produce no matches
```

With the stack up: create a prescription from the doctor console, copy its `qr_payload`,
then:

```powershell
$qr = "<base64 qr_payload>"

# 1. active -> valid
Invoke-RestMethod -Method Post -Uri http://localhost/api/prescription/verify-qr `
  -ContentType 'application/json' -Body (@{ qr_payload = $qr } | ConvertTo-Json)
# expect valid = True

# 2. revoke it -> reason 'revoked'
$rxid = "<the rx_id inside the payload>"
docker compose exec postgres psql -U opd_user -d opd_preconsult -c `
  "UPDATE prescriptions SET status='cancelled' WHERE id='$rxid';"

Invoke-RestMethod -Method Post -Uri http://localhost/api/prescription/verify-qr `
  -ContentType 'application/json' -Body (@{ qr_payload = $qr } | ConvertTo-Json)
# expect valid = False, reason = revoked

# 3. tamper one character of the payload -> invalid_signature
$bad = $qr.Substring(0, $qr.Length - 2) + "AA"
Invoke-RestMethod -Method Post -Uri http://localhost/api/prescription/verify-qr `
  -ContentType 'application/json' -Body (@{ qr_payload = $bad } | ConvertTo-Json)
# expect valid = False
```

Restore `status='active'` afterwards, then scan the QR through
`http://localhost/rx/verify` and confirm the page still renders the prescription.

## Done when

All three `Invoke-RestMethod` calls return the stated shapes, `sig !== expected` is
gone, and the `/rx/verify` page still works in the browser.
