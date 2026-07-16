# 02 — Doctor PIN: unsalted SHA-256, no login rate limit

**Severity:** High · **Effort:** Medium
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/package.json`
- `services/node-backend/src/routes/doctor.js`
- `services/node-backend/src/index.js`
- `services/gateway/nginx.conf`

Nothing else. **No database migration is needed** — `doctors.pin_hash` is already
`VARCHAR(128)` and a bcrypt hash is 60 characters.

## The problem

`services/node-backend/src/routes/doctor.js`:

```js
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}
```

A PIN is 4–6 digits. Unsalted SHA-256 over a 4-digit PIN means 10,000 possible
hashes — precomputable instantly, and identical PINs produce identical hashes
across doctors.

Separately, `POST /api/doctor/login` has no attempt limiting. `services/gateway/nginx.conf`
defines `limit_req_zone` for `otp` and `uploads`, but the `location /api/doctor`
block has no `limit_req` at all. Online brute force of a 4-digit PIN takes seconds.

## Decisions (already made — do not deviate)

1. **Use `bcryptjs`, not `bcrypt`.** `bcryptjs` is pure JavaScript with no native
   build step, which matters for the Alpine-based Docker images. Cost factor **10**.
2. **Migrate hashes lazily on successful login.** Do not write a migration that
   rehashes existing rows — you cannot, you do not have the plaintext PINs.
   Instead: if the stored hash is a 64-char hex string, it is a legacy SHA-256
   hash; verify against SHA-256, and on success immediately replace it with a
   bcrypt hash. Every subsequent login uses bcrypt.
3. **Keep `hashPin` as the legacy verifier only.** Rename it `legacySha256Pin` so
   nobody reaches for it to hash a new PIN.
4. **Rate limit at nginx**, keyed on client IP, using an exact-match location so
   it applies to `/api/doctor/login` only and not the rest of `/api/doctor`.

## Required change

### 1. Dependency

Add to `services/node-backend/package.json` `dependencies` (keep alphabetical order):

```json
"bcryptjs": "^2.4.3",
```

Then:

```powershell
cd services\node-backend
npm install
```

### 2. `doctor.js` — hashing

Add the import at the top, next to `const crypto = require('crypto');`:

```js
const bcrypt = require('bcryptjs');
```

Replace the `hashPin` function with:

```js
const BCRYPT_ROUNDS = 10;

// Hash a NEW pin. Always bcrypt.
async function hashPin(pin) {
  return bcrypt.hash(String(pin), BCRYPT_ROUNDS);
}

// Legacy scheme: unsalted SHA-256 hex. Kept ONLY to verify pre-existing rows so
// they can be transparently upgraded on the doctor's next successful login.
// Never use this to store a new PIN.
function legacySha256Pin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

const isLegacyHash = (h) => typeof h === 'string' && /^[a-f0-9]{64}$/i.test(h);

// Verify `pin` against whatever scheme `stored` uses. Returns { ok, needsUpgrade }.
async function verifyPin(pin, stored) {
  if (isLegacyHash(stored)) {
    const a = Buffer.from(legacySha256Pin(pin));
    const b = Buffer.from(stored);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, needsUpgrade: ok };
  }
  return { ok: await bcrypt.compare(String(pin), stored || ''), needsUpgrade: false };
}
```

### 3. `doctor.js` — login

In `router.post('/login', ...)`, replace:

```js
    const doctor = result.rows[0];
    if (doctor.pin_hash !== hashPin(pin)) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }
```

with:

```js
    const doctor = result.rows[0];
    const { ok, needsUpgrade } = await verifyPin(pin, doctor.pin_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid PIN' });
    }
    // Transparent upgrade: this doctor's row still holds a legacy SHA-256 hash and
    // we have just proved the plaintext PIN. Re-store it under bcrypt. Best-effort —
    // a failure here must not block a valid login.
    if (needsUpgrade) {
      try {
        await pool.query('UPDATE doctors SET pin_hash = $1 WHERE id = $2', [await hashPin(pin), doctor.id]);
        console.log(`[auth] upgraded legacy PIN hash for doctor ${doctor.id}`);
      } catch (e) {
        console.warn('[auth] PIN hash upgrade failed (non-fatal):', e.message);
      }
    }
```

### 4. `doctor.js` — the three other `hashPin` call sites

`hashPin` is now **async**. Every call site must `await` it. They are all already
inside `async` handlers.

- In `router.post('/', ...)` (create doctor): `hashPin(pin)` → `await hashPin(pin)`
- In `router.patch('/:id', ...)` (edit doctor): `params.push(hashPin(pin))` → `params.push(await hashPin(pin))`
- In `router.post('/change-pin', ...)`:

  replace

  ```js
    const doc = await pool.query('SELECT pin_hash FROM doctors WHERE id = $1', [decoded.doctor_id]);
    if (!doc.rows.length || doc.rows[0].pin_hash !== hashPin(old_pin)) {
      return res.status(401).json({ error: 'Invalid current PIN' });
    }

    await pool.query('UPDATE doctors SET pin_hash = $1 WHERE id = $2', [hashPin(new_pin), decoded.doctor_id]);
  ```

  with

  ```js
    const doc = await pool.query('SELECT pin_hash FROM doctors WHERE id = $1', [decoded.doctor_id]);
    if (!doc.rows.length) return res.status(401).json({ error: 'Invalid current PIN' });
    const { ok } = await verifyPin(old_pin, doc.rows[0].pin_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid current PIN' });

    await pool.query('UPDATE doctors SET pin_hash = $1 WHERE id = $2', [await hashPin(new_pin), decoded.doctor_id]);
  ```

**Search the whole file for `hashPin(` afterwards and confirm every call is awaited.**

### 5. `index.js` — the default-PIN warning breaks

`services/node-backend/src/index.js` contains a startup check comparing against a
hardcoded SHA-256 of `1234`:

```js
    const DEFAULT_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4';
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM doctors WHERE is_active = true AND pin_hash = $1',
      [DEFAULT_PIN_HASH]
    );
```

Once hashes are bcrypt this silently matches nothing and the warning disappears —
worse than before, because it looks like it passed. Replace the whole `try` block
body with a version that tests each active doctor:

```js
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const LEGACY_DEFAULT = crypto.createHash('sha256').update('1234').digest('hex');
    const pool = require('./models/db');
    const { rows } = await pool.query('SELECT pin_hash FROM doctors WHERE is_active = true');
    let n = 0;
    for (const r of rows) {
      const h = r.pin_hash || '';
      const isDefault = /^[a-f0-9]{64}$/i.test(h)
        ? h === LEGACY_DEFAULT
        : await bcrypt.compare('1234', h).catch(() => false);
      if (isDefault) n++;
    }
    if (n > 0) {
      const msg = `[security] ${n} active doctor(s) still use the default demo PIN (1234). Reset before real use.`;
      if (process.env.NODE_ENV === 'production') console.error('⚠️  ' + msg);
      else console.warn(msg);
    }
```

Keep the surrounding `try { ... } catch { /* non-fatal */ }`.

### 6. `nginx.conf` — rate limit the login

Add a zone next to the existing `limit_req_zone` lines at the top of the file:

```nginx
# Credential-stuffing / PIN brute-force guard. A doctor PIN is 4-6 digits, so the
# keyspace is small — this is the primary defence, not a nicety.
limit_req_zone $binary_remote_addr zone=login:10m rate=10r/m;
```

Then add these two **exact-match** locations. They must appear **before** the
existing `location /api/doctor` and `location /api/admin` blocks. Exact-match
(`=`) locations take priority in nginx regardless of order, but keep them above
for readability:

```nginx
    location = /api/doctor/login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass $node_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location = /api/admin/login {
        limit_req zone=login burst=5 nodelay;
        proxy_pass $node_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
```

## Acceptance criteria

- [ ] `bcryptjs` is in `package.json` dependencies and installed.
- [ ] No code path stores a SHA-256 hash. `legacySha256Pin` is only ever read from.
- [ ] Every `hashPin(...)` call is `await`ed.
- [ ] A doctor whose row still holds a legacy hash can log in with their existing
      PIN, and their `pin_hash` is a bcrypt string (`$2a$`/`$2b$` prefix) afterwards.
- [ ] A doctor created after this change gets a bcrypt hash immediately.
- [ ] `change-pin` works with both a legacy and a bcrypt current hash.
- [ ] The startup default-PIN warning still fires for a doctor whose PIN is `1234`.
- [ ] The 11th login attempt from one IP within a minute gets HTTP `503` from nginx.

## How to verify

```powershell
cd services\node-backend
npm install
node --check src\routes\doctor.js
node --check src\index.js
```

With the stack up:

```powershell
# 1. Create a doctor via HIS, or directly:
$a = (Invoke-RestMethod -Method Post -Uri http://localhost/api/admin/login `
      -ContentType 'application/json' -Body '{"passcode":"<ADMIN_PASSCODE>","admin_name":"t"}').token
Invoke-RestMethod -Method Post -Uri http://localhost/api/doctor `
  -Headers @{ Authorization = "Bearer $a" } -ContentType 'application/json' `
  -Body '{"name":"Test Doc","department":"OPD","phone":"9999999999","pin":"4321"}'

# 2. Login must succeed
Invoke-RestMethod -Method Post -Uri http://localhost/api/doctor/login `
  -ContentType 'application/json' -Body '{"phone":"9999999999","pin":"4321"}'

# 3. Hash must be bcrypt, not 64 hex chars
docker compose exec postgres psql -U opd_user -d opd_preconsult -c `
  "SELECT phone, left(pin_hash, 4) AS scheme, length(pin_hash) FROM doctors WHERE phone='9999999999';"
# expect scheme like '$2a$' or '$2b$', length 60
```

Legacy-upgrade path — insert a SHA-256 row by hand and confirm it upgrades:

```powershell
# sha256('1234') = 03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4
docker compose exec postgres psql -U opd_user -d opd_preconsult -c `
  "UPDATE doctors SET pin_hash='03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4' WHERE phone='9999999999';"

Invoke-RestMethod -Method Post -Uri http://localhost/api/doctor/login `
  -ContentType 'application/json' -Body '{"phone":"9999999999","pin":"1234"}'

docker compose exec postgres psql -U opd_user -d opd_preconsult -c `
  "SELECT length(pin_hash) FROM doctors WHERE phone='9999999999';"
# expect 60, not 64
```

Rate limit:

```powershell
1..15 | ForEach-Object {
  curl.exe -s -o NUL -w "%{http_code} " -X POST http://localhost/api/doctor/login `
    -H "Content-Type: application/json" --data '{"phone":"9999999999","pin":"0000"}'
}
# expect a run of 401s then 503s
```

Clean up the test doctor afterwards.

## Done when

All acceptance boxes are checked, including the legacy-upgrade round trip and the
`503` from the rate limiter.
