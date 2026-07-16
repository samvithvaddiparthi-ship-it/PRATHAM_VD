# 10 — `db.py` opens a new Postgres connection per query

**Severity:** Medium · **Effort:** Medium
**Read [README.md](README.md) ground rules first.**

## Files you may touch

- `services/python-backend/src/db.py`

Nothing else. Every caller keeps the same `query(sql, params)` / `execute(sql, params)`
signature and the same return type (`list[dict]`).

## The problem

`services/python-backend/src/db.py` in full:

```python
def get_conn():
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        return psycopg2.connect(db_url)
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        ...
    )

def query(sql, params=None):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            if cur.description:
                return cur.fetchall()
            conn.commit()
            return []
    finally:
        conn.close()

def execute(sql, params=None):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            conn.commit()
            if cur.description:
                return cur.fetchall()
            return []
    finally:
        conn.close()
```

Two defects.

**A — no pooling.** A TCP connect + TLS handshake + Postgres auth round trip for
*every single query*. `report.py` alone issues four per report. Under a real OPD load
this exhausts `max_connections` (default 100) and adds tens of milliseconds to each call.

**B — `query()` silently discards writes.** Look at the control flow: when
`cur.description` is truthy (any `SELECT`, or an `INSERT ... RETURNING`), it returns
`fetchall()` **without committing**. `conn.close()` then rolls the transaction back.

Today no caller hits this — every `RETURNING` insert correctly uses `execute()`. It is
a live landmine: the next person who writes `query("INSERT ... RETURNING id")` gets
rows back and no row in the table.

## Decisions (already made — do not deviate)

1. Use **`psycopg2.pool.ThreadedConnectionPool`**. FastAPI runs these sync functions in
   a thread pool, so the pool must be thread-safe. Do not use `SimpleConnectionPool`.
2. **Do not switch to async / `asyncpg` / SQLAlchemy.** That is a rewrite of every
   caller. Out of scope.
3. Pool size: `minconn=1`, `maxconn=int(os.getenv("DB_POOL_MAX", "10"))`.
4. **Initialise lazily**, on first use, not at import. `db.py` is imported by modules
   that must load even when Postgres is down (the app has to start and serve `/health`
   while waiting for the DB).
5. **`query()` must commit too.** Make both functions commit unconditionally before
   returning. Committing after a plain `SELECT` is a cheap no-op and removes the
   footgun entirely. Do not "fix" this by documenting it.
6. Connections must be returned to the pool on **every** path, including exceptions.
   A connection that saw an exception must be discarded (`putconn(conn, close=True)`),
   not reused — it may be left in a failed transaction state.
7. Keep `RealDictCursor` so callers keep getting dicts.

## Required change

Replace the entire contents of `services/python-backend/src/db.py` with:

```python
"""Postgres access for the python-backend.

A ThreadedConnectionPool, because FastAPI runs these synchronous helpers in its
thread pool. Previously every query opened and closed its own connection — a full
TCP + auth round trip per statement, which exhausts max_connections under load.

Both helpers COMMIT before returning. An earlier version of query() returned rows
from an `INSERT ... RETURNING` without committing, so closing the connection rolled
the write back. Committing after a SELECT is a no-op, so there is no reason to make
the caller think about which helper is safe for writes.
"""
import os
import threading
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
import psycopg2.pool

_pool = None
_pool_lock = threading.Lock()


def _dsn_kwargs():
    # Railway / Heroku style DATABASE_URL takes precedence.
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        return {"dsn": db_url}
    return {
        "host": os.getenv("POSTGRES_HOST", "localhost"),
        "port": int(os.getenv("POSTGRES_PORT", "5432")),
        "dbname": os.getenv("POSTGRES_DB", "opd_preconsult"),
        "user": os.getenv("POSTGRES_USER", "opd_user"),
        "password": os.getenv("POSTGRES_PASSWORD", "changeme_in_production"),
    }


def _get_pool():
    """Create the pool on first use.

    Lazy on purpose: db.py is imported by modules that must load even when Postgres
    is not up yet, so the app can start and answer /health while it waits.
    """
    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            maxconn = int(os.getenv("DB_POOL_MAX", "10"))
            _pool = psycopg2.pool.ThreadedConnectionPool(1, maxconn, **_dsn_kwargs())
            print(f"[db] connection pool ready (1..{maxconn})", flush=True)
    return _pool


@contextmanager
def _conn():
    """Lease a connection. Returned to the pool on success; DISCARDED on error, since
    a connection that raised may be sitting in a failed transaction."""
    pool = _get_pool()
    conn = pool.getconn()
    try:
        yield conn
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        pool.putconn(conn, close=True)
        raise
    else:
        pool.putconn(conn)


def _run(sql, params):
    with _conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall() if cur.description else []
            conn.commit()
            return rows


def query(sql, params=None):
    """Run `sql`. Returns a list of dicts (empty for statements with no result set).
    Commits — safe for writes, including `INSERT ... RETURNING`."""
    return _run(sql, params)


def execute(sql, params=None):
    """Alias of query(), kept because most write call sites say `execute`."""
    return _run(sql, params)


def close_pool():
    """Close every pooled connection. For tests / shutdown hooks."""
    global _pool
    with _pool_lock:
        if _pool is not None:
            _pool.closeall()
            _pool = None
```

Note `fetchall()` is called **before** `commit()`. psycopg2 buffers the full result
client-side on `execute()`, so this ordering is safe and avoids relying on
cursor-after-commit behaviour.

## Gotchas

- `psycopg2.pool.ThreadedConnectionPool` takes the DSN as the first positional arg or
  as keyword connection params, not both. `_dsn_kwargs()` returns one or the other —
  do not merge them.
- `getconn()` **blocks** when the pool is exhausted; it does not queue with a timeout.
  If you see the app hang under load, `DB_POOL_MAX` is too low, not the pool's fault.
- `storage.py`, `view_audit.py`, and every router import `query`/`execute` by name.
  Keep both exported.

## Acceptance criteria

- [ ] `db.py` exposes `query`, `execute`, and `close_pool`, with unchanged signatures
      for the first two.
- [ ] No module-level connection or pool is created at import time.
- [ ] `query("INSERT ... RETURNING id")` returns the row **and** persists it.
- [ ] An exception inside a query does not leak a connection, and the failed
      connection is closed rather than returned to the pool.
- [ ] `psycopg2.connect` no longer appears anywhere in `src/`.
- [ ] The 32 existing tests still pass.
- [ ] `docker compose exec postgres psql -c "SELECT count(*) FROM pg_stat_activity"`
      stays flat while the app serves requests, rather than climbing.

## How to verify

```powershell
cd services\python-backend
python -m compileall -q src
python -m pytest tests\ -q
Select-String -Path src\*.py, src\routers\*.py -Pattern 'psycopg2\.connect'
# must produce no matches
```

Commit-on-query regression (this is the landmine — assert it is gone). With the stack up:

```powershell
docker compose exec python-backend python -c @"
from src.db import query
rows = query(\"INSERT INTO audit_log (event_type, actor) VALUES ('pooltest','t') RETURNING id\")
print('returned:', rows)
print('persisted:', query(\"SELECT count(*) AS n FROM audit_log WHERE event_type='pooltest'\"))
"@
# expect persisted n = 1  (before this fix it would be 0)

docker compose exec postgres psql -U opd_user -d opd_preconsult -c "DELETE FROM audit_log WHERE event_type='pooltest';"
```

Connection count stays flat:

```powershell
docker compose exec postgres psql -U opd_user -d opd_preconsult -tAc `
  "SELECT count(*) FROM pg_stat_activity WHERE datname='opd_preconsult';"
# note the number, hit the doctor dashboard hard for 30s, run again — should not climb
```

## Done when

`psycopg2.connect` is gone from `src/`, the `RETURNING` insert persists, tests pass,
and the connection count is stable under load.
