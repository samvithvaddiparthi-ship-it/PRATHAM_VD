import os
import threading
import psycopg2
import psycopg2.extras
import psycopg2.pool


def _connect_kwargs():
    # Railway / Heroku style DATABASE_URL takes precedence.
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        return {"dsn": db_url}
    return dict(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        dbname=os.getenv("POSTGRES_DB", "opd_preconsult"),
        user=os.getenv("POSTGRES_USER", "opd_user"),
        password=os.getenv("POSTGRES_PASSWORD", "changeme_in_production"),
    )


def get_conn():
    # A RAW, un-pooled connection. Kept for the few callers that manage their own
    # connection lifecycle (drug_repo's one-time schema/seed at startup). Request
    # hot paths must use query()/execute(), which are pooled — see below.
    return psycopg2.connect(**_connect_kwargs())


# ── Connection pool ───────────────────────────────────────────────────────────
# query()/execute() run on every request (report, triage, OCR, audio, scribe,
# audit). Opening a brand-new Postgres connection per call churned connections and
# could exhaust the server's connection slots under load. We borrow from a bounded,
# thread-safe pool instead. Size via DB_POOL_MIN / DB_POOL_MAX.
_pool = None
_pool_lock = threading.Lock()

# Connection-level failures (server restart, dropped socket, idle timeout). On
# these we discard the broken connection and retry once with a fresh one.
_CONN_ERRORS = (psycopg2.OperationalError, psycopg2.InterfaceError)


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                minc = int(os.getenv("DB_POOL_MIN", "1"))
                maxc = int(os.getenv("DB_POOL_MAX", "10"))
                _pool = psycopg2.pool.ThreadedConnectionPool(minc, maxc, **_connect_kwargs())
    return _pool


def _run(sql, params):
    """Execute one statement on a pooled connection and return rows (or []).

    Always commits so the connection never returns to the pool "idle in
    transaction" — this also means an INSERT ... RETURNING run through query()
    is committed (a previous version returned before committing and silently
    rolled the write back). Retries once if the borrowed connection is dead.
    """
    pool = _get_pool()
    for attempt in (1, 2):
        conn = pool.getconn()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall() if cur.description else []
            conn.commit()
            pool.putconn(conn)
            return rows
        except _CONN_ERRORS:
            # Broken connection — drop it from the pool (so a new one is created
            # next time) and retry once with a fresh connection.
            try:
                conn.rollback()
            except Exception:
                pass
            pool.putconn(conn, close=True)
            if attempt == 2:
                raise
        except Exception:
            # A real query error — the connection is still healthy after rollback,
            # so return it to the pool and surface the error immediately.
            try:
                conn.rollback()
            except Exception:
                pass
            pool.putconn(conn)
            raise


def query(sql, params=None):
    return _run(sql, params)


def execute(sql, params=None):
    return _run(sql, params)
