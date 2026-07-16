# 09 — OTP verify ignores `session_id`

**Severity:** Medium · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/routes/otp.js`

Nothing else. **No migration** — `phone_otps.session_id` already exists and is
already indexed (`idx_phone_otps_session`).

## The problem

`db/migrations/023_phone_otp.sql` stores the session an OTP was issued for:

```sql
CREATE TABLE IF NOT EXISTS phone_otps (
  id          SERIAL PRIMARY KEY,
  phone       VARCHAR(20)  NOT NULL,
  session_id  UUID         REFERENCES sessions(id) ON DELETE CASCADE,
  ...
);
CREATE INDEX IF NOT EXISTS idx_phone_otps_session  ON phone_otps (session_id);
```

`POST /api/otp/request` writes it. `POST /api/otp/verify` never reads it:

```js
    // The active challenge: latest unverified, unexpired code for this phone.
    const r = await pool.query(
      `SELECT id, code_hash, attempts FROM phone_otps
        WHERE phone = $1 AND verified = false AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
```

Two consequences.

**Security (minor).** A code issued for session A can be redeemed to mark session B
as `phone_verified`. Exploiting it requires knowing the code, so this is
defence-in-depth rather than an open door — but the column exists precisely to
prevent it and is simply unused.

**Correctness (user-visible).** Only the single newest row is considered. If a
patient taps "Resend" and then types the code from the **first** SMS (which is still
within its 5-minute TTL, and SMS arrive out of order), they get
`"Code expired or not found. Request a new one."` — even though the code is valid.

## Decisions (already made — do not deviate)

1. **Scope the challenge lookup to `phone AND session_id`.** Both must match.
2. **Accept any unexpired, unverified code for that (phone, session)** — not only
   the newest. This fixes the resend/out-of-order case. Match against every candidate
   row; the attempt counter is incremented on the newest one when nothing matches, so
   the existing brute-force cap still bites.
3. **Keep `crypto.timingSafeEqual`** for the hash comparison, exactly as today.
4. Legacy rows may have `session_id IS NULL` (written before this column was used).
   **Ignore them** — they are expired within 5 minutes anyway. Do not add a fallback
   that accepts `session_id IS NULL`; that would reintroduce the hole.
5. Do **not** change `POST /api/otp/request`. It already writes `session_id`.
6. Do **not** change the rate limits, which are correctly keyed on `phone` alone
   (a per-session limit would be trivially bypassed by rescanning the QR).

## Required change

In `router.post('/verify', ...)`, replace this block:

```js
    // The active challenge: latest unverified, unexpired code for this phone.
    const r = await pool.query(
      `SELECT id, code_hash, attempts FROM phone_otps
        WHERE phone = $1 AND verified = false AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rows.length) {
      return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
    }
    const otp = r.rows[0];
    if (otp.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }

    const expected = Buffer.from(otp.code_hash);
    const got = Buffer.from(hashCode(phone, code));
    const ok = expected.length === got.length && crypto.timingSafeEqual(expected, got);
    if (!ok) {
      await pool.query('UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      const left = MAX_ATTEMPTS - (otp.attempts + 1);
      return res.status(401).json({ error: left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Incorrect code. Request a new one.' });
    }

    // Success: retire the code and stamp the session as phone-verified for this
    // exact number (register checks both).
    await pool.query('UPDATE phone_otps SET verified = true WHERE id = $1', [otp.id]);
```

with:

```js
    // Active challenges: EVERY unverified, unexpired code issued for this phone AND
    // THIS session. Scoping to session_id means a code minted for one session can't
    // verify another. Considering all live rows (not just the newest) means a patient
    // who taps Resend and then types the FIRST SMS they received still succeeds —
    // both codes are within their 5-minute TTL and SMS arrive out of order.
    const r = await pool.query(
      `SELECT id, code_hash, attempts FROM phone_otps
        WHERE phone = $1 AND session_id = $2 AND verified = false AND expires_at > NOW()
        ORDER BY created_at DESC`,
      [phone, session_id]
    );
    if (!r.rows.length) {
      return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
    }

    // The newest row carries the attempt counter for this challenge round.
    const newest = r.rows[0];
    if (newest.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many incorrect attempts. Request a new code.' });
    }

    const got = Buffer.from(hashCode(phone, code));
    const match = r.rows.find((row) => {
      const expected = Buffer.from(row.code_hash);
      return expected.length === got.length && crypto.timingSafeEqual(expected, got);
    });

    if (!match) {
      await pool.query('UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1', [newest.id]);
      const left = MAX_ATTEMPTS - (newest.attempts + 1);
      return res.status(401).json({ error: left > 0 ? `Incorrect code. ${left} attempt(s) left.` : 'Incorrect code. Request a new one.' });
    }

    // Success: retire every live code for this session (so a resent code can't be
    // replayed) and stamp the session as phone-verified for this exact number.
    await pool.query(
      'UPDATE phone_otps SET verified = true WHERE phone = $1 AND session_id = $2 AND verified = false',
      [phone, session_id]
    );
```

The `UPDATE sessions SET patient_phone = ..., phone_verified = true ...` immediately
below is unchanged.

`session_id` is already in scope — the handler destructures it from `req.session_data`
on its first line.

## Acceptance criteria

- [ ] The challenge query filters on both `phone` and `session_id`.
- [ ] All live candidate rows are compared, not just the newest.
- [ ] `crypto.timingSafeEqual` is still used for every comparison.
- [ ] On success, **all** unverified rows for that (phone, session) are marked verified.
- [ ] On failure, the attempt counter increments on exactly one row (the newest).
- [ ] Requesting two codes and submitting the **first** one succeeds.
- [ ] A code requested under session A cannot verify session B (returns `400`).
- [ ] Five wrong guesses still produce `429`.

## How to verify

```powershell
cd services\node-backend
node --check src\routes\otp.js
```

Behavioural. Set `OTP_RESEND_SECONDS=0` and `OTP_MAX_PER_HOUR=100` in `.env`, restart,
and leave Twilio unconfigured so `dev_code` is returned.

```powershell
# Session A
$a = (Invoke-RestMethod -Method Post -Uri http://localhost/api/session/scan `
      -ContentType 'application/json' `
      -Body (@{ qr_payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"hospital_id":"hospital_01"}')) } | ConvertTo-Json)).token

# Two codes for the same phone+session
$c1 = (Invoke-RestMethod -Method Post -Uri http://localhost/api/otp/request `
        -Headers @{ Authorization = "Bearer $a" } -ContentType 'application/json' `
        -Body '{"phone":"9876543210"}').dev_code
$c2 = (Invoke-RestMethod -Method Post -Uri http://localhost/api/otp/request `
        -Headers @{ Authorization = "Bearer $a" } -ContentType 'application/json' `
        -Body '{"phone":"9876543210"}').dev_code

# The FIRST code must still work (this is the bug being fixed)
Invoke-RestMethod -Method Post -Uri http://localhost/api/otp/verify `
  -Headers @{ Authorization = "Bearer $a" } -ContentType 'application/json' `
  -Body "{""phone"":""9876543210"",""code"":""$c1""}"
# expect verified = True
```

Cross-session rejection:

```powershell
# Session B, fresh token
$b = (Invoke-RestMethod -Method Post -Uri http://localhost/api/session/scan `
      -ContentType 'application/json' `
      -Body (@{ qr_payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"hospital_id":"hospital_01"}')) } | ConvertTo-Json)).token

# Request a code as A, try to redeem it as B
$c3 = (Invoke-RestMethod -Method Post -Uri http://localhost/api/otp/request `
        -Headers @{ Authorization = "Bearer $a" } -ContentType 'application/json' `
        -Body '{"phone":"9811111111"}').dev_code

curl.exe -s -o - -w "`n%{http_code}`n" -X POST http://localhost/api/otp/verify `
  -H "Authorization: Bearer $b" -H "Content-Type: application/json" `
  --data "{\"phone\":\"9811111111\",\"code\":\"$c3\"}"
# expect 400 "Code expired or not found."
```

Brute-force cap: submit five wrong codes on one session and confirm the sixth returns
`429`.

Reset `OTP_RESEND_SECONDS` / `OTP_MAX_PER_HOUR` in `.env` afterwards.

## Done when

The first-of-two-codes call verifies, the cross-session call returns `400`, and the
`429` cap still fires.
