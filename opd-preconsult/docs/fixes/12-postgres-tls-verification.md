# 12 — `rejectUnauthorized: false` on the production DB connection

**Severity:** Medium · **Effort:** Small
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/node-backend/src/models/db.js`
- `.env.example`

Nothing else. **Do not touch `services/python-backend/src/db.py`** — that file is being
rewritten by task [10](10-python-db-connection-pooling.md). If you are doing both, do
task 10 first, then apply the same env-var convention there.

## The problem

`services/node-backend/src/models/db.js`:

```js
if (process.env.DATABASE_URL) {
  config = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') || process.env.DATABASE_URL.includes('.proxy.') || process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  };
}
```

`rejectUnauthorized: false` disables certificate verification. TLS still encrypts the
link, but nothing proves the server on the other end is your database. Anyone who can
get between the app and Postgres — on the hosting provider's network, or via a DNS or
routing hijack — can present any certificate, terminate the TLS, and read and rewrite
every query. That traffic is the entire patient record.

The condition also silently *enables* this weakened mode precisely when `NODE_ENV=production`.

## Why it was written that way

Railway (and most managed Postgres behind a proxy) presents a certificate signed by an
internal CA that is not in Node's trust store. With verification on and no CA supplied,
the connection fails. So the choice was "verify nothing" versus "does not connect".

There is a third option, which is what we want: **supply the CA**.

## Decisions (already made — do not deviate)

1. **Verify by default.** `rejectUnauthorized` is `true` unless explicitly overridden.
2. **`DATABASE_CA_CERT`** — if set, its contents are used as the trusted CA. This is the
   correct fix for Railway/Supabase/RDS: paste the provider's CA PEM into the env var.
3. **`DATABASE_SSL_INSECURE=true`** — an explicit, loudly-logged escape hatch that
   restores the old behaviour. It exists so a deploy can be unblocked in one env-var
   change rather than a rollback. It must **print a warning on every startup**, and the
   warning must be an `error`-level log in production so it shows up in alerting.
4. **Do not auto-detect on hostname.** Delete the `.includes('railway')` /
   `.includes('.proxy.')` sniffing. Whether TLS is required is a deployment fact, not a
   string-matching guess.
5. **`DATABASE_SSL=disable`** turns TLS off entirely — for local Docker, where Postgres
   is on the compose network and speaks plaintext. This is the default when
   `NODE_ENV !== 'production'` and no other flag is set.
6. Do **not** fail startup when the escape hatch is used. Warn, connect, move on.
   Refusing to boot a running hospital deployment over a config nit is worse than the nit.

## Required change

### `services/node-backend/src/models/db.js`

Replace the whole config block (everything from `let config;` down to
`const pool = new Pool(config);`) with:

```js
const fs = require('fs');

// ── TLS to Postgres ──────────────────────────────────────────────────────────
// The link to the DB carries the entire patient record. Encrypting it without
// verifying the server's certificate (rejectUnauthorized: false) stops a passive
// eavesdropper but not an active one — anyone able to intercept the connection can
// present any cert and read/rewrite every query.
//
// So: verify by default. Managed providers (Railway, Supabase, RDS) sign with an
// internal CA that Node does not trust out of the box — give it to us via
// DATABASE_CA_CERT rather than turning verification off.
//
//   DATABASE_SSL=disable       -> no TLS at all (local docker-compose; the DB is on
//                                 the compose network and speaks plaintext)
//   DATABASE_CA_CERT=<PEM>     -> verify against this CA        [recommended in prod]
//   DATABASE_CA_CERT_FILE=path -> same, read from a file
//   DATABASE_SSL_INSECURE=true -> encrypt but DO NOT verify     [escape hatch, warns]
//   (nothing set, production)  -> verify against the system CA store
function resolveSsl() {
  const IS_PROD = process.env.NODE_ENV === 'production';

  if ((process.env.DATABASE_SSL || '').toLowerCase() === 'disable') return false;
  if (!IS_PROD && !process.env.DATABASE_SSL && !process.env.DATABASE_CA_CERT && !process.env.DATABASE_CA_CERT_FILE) {
    return false; // local dev default: plaintext to the compose-network Postgres
  }

  if ((process.env.DATABASE_SSL_INSECURE || '').toLowerCase() === 'true') {
    const msg = '[db] DATABASE_SSL_INSECURE=true — TLS certificate verification is OFF. '
              + 'The connection is encrypted but NOT authenticated: an active network '
              + 'attacker can read and modify every query. Set DATABASE_CA_CERT instead.';
    if (IS_PROD) console.error('⚠️  ' + msg); else console.warn(msg);
    return { rejectUnauthorized: false };
  }

  let ca = process.env.DATABASE_CA_CERT || null;
  if (!ca && process.env.DATABASE_CA_CERT_FILE) {
    try {
      ca = fs.readFileSync(process.env.DATABASE_CA_CERT_FILE, 'utf8');
    } catch (err) {
      throw new Error(`[db] DATABASE_CA_CERT_FILE could not be read: ${err.message}`);
    }
  }

  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

let config;

// Railway / Heroku style DATABASE_URL takes precedence
if (process.env.DATABASE_URL) {
  config = {
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
  };
} else {
  config = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'opd_preconsult',
    user: process.env.POSTGRES_USER || 'opd_user',
    password: process.env.POSTGRES_PASSWORD || 'changeme_in_production',
    ssl: resolveSsl(),
  };
}

console.log('[db] Connecting to:', config.connectionString ? 'DATABASE_URL' : `${config.host}:${config.port}/${config.database}`);
console.log('[db] TLS:', config.ssl === false ? 'disabled' : (config.ssl.rejectUnauthorized ? 'verified' : 'ENCRYPTED BUT UNVERIFIED'));

const pool = new Pool(config);
```

Note the `else` branch now sets `ssl` too — it previously had none, so `POSTGRES_HOST`
deployments could never use TLS at all.

### `.env.example`

Under the existing PostgreSQL block, add:

```bash
# TLS to Postgres. The DB link carries the whole patient record, so the certificate is
# VERIFIED by default. Local docker-compose speaks plaintext on the compose network,
# which is the dev default — you do not need to set anything.
#
# In production with a managed DB (Railway/Supabase/RDS), paste the provider's CA PEM:
# DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
#   ...or point at a mounted file:
# DATABASE_CA_CERT_FILE=/etc/ssl/certs/db-ca.pem
#
# DATABASE_SSL=disable        # no TLS at all
# DATABASE_SSL_INSECURE=true  # encrypt but skip verification. Escape hatch only —
#                             # logs an error every startup. An active attacker on the
#                             # network can read and rewrite every query.
```

## Acceptance criteria

- [ ] `rejectUnauthorized: false` appears exactly once, inside the
      `DATABASE_SSL_INSECURE` branch, and that branch logs a warning.
- [ ] The `.includes('railway')` / `.includes('.proxy.')` hostname sniffing is deleted.
- [ ] With nothing set and `NODE_ENV` unset, `ssl` is `false` (local dev still works).
- [ ] With `NODE_ENV=production` and nothing else set, `ssl.rejectUnauthorized === true`.
- [ ] With `DATABASE_CA_CERT` set, the CA is passed to `pg` and `rejectUnauthorized` is `true`.
- [ ] With `DATABASE_SSL_INSECURE=true` and `NODE_ENV=production`, startup logs at
      `console.error` and the app still connects.
- [ ] `DATABASE_CA_CERT_FILE` pointing at a missing path throws a clear error at startup.
- [ ] `docker compose up` still works with no new env vars.

## How to verify

```powershell
cd services\node-backend
node --check src\models\db.js
```

Unit-check `resolveSsl()` through the module's log line, without a real DB:

```powershell
# local dev default -> TLS: disabled
node -e "process.env.DATABASE_URL='postgres://u:p@h/d'; require('./src/models/db.js');"

# production, nothing else -> TLS: verified
$env:NODE_ENV='production'
node -e "process.env.DATABASE_URL='postgres://u:p@h/d'; require('./src/models/db.js');"

# escape hatch -> error-level warning + 'ENCRYPTED BUT UNVERIFIED'
$env:DATABASE_SSL_INSECURE='true'
node -e "process.env.DATABASE_URL='postgres://u:p@h/d'; require('./src/models/db.js');"

Remove-Item Env:NODE_ENV, Env:DATABASE_SSL_INSECURE
```

Then confirm the stack still comes up unchanged:

```powershell
docker compose up -d --build
docker compose logs node-backend | Select-String "\[db\] TLS"
# expect: [db] TLS: disabled     (compose-network Postgres, plaintext)
docker compose logs node-backend | Select-String "Running on port"
```

## Done when

The four `node -e` invocations print the expected `[db] TLS:` line, `docker compose up`
still connects, and `rejectUnauthorized: false` exists only behind the warned escape hatch.
