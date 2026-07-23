'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { api, setToken } from '../../lib/api';

// Nursing station — the combined nurse / help-desk / social-worker board.
//
// Shows live RED-triage patients so someone physically attends to / escalates them.
// Two feeds working together:
//   • pull  — GET /api/staff/alerts on load + a slow poll, so a nurse arriving
//             mid-shift sees REDs already waiting (SSE alone only catches NEW events)
//   • push  — the SSE stream (/api/alerts/stream) fires the instant a new RED is
//             raised; we just refetch the list so both feeds stay consistent
//
// Privacy: the board shows the TOKEN number, not the patient's name — a token is
// what you call out to locate the patient, and it keeps a shared (nurse + social
// worker) role clear of clinical PHI. The token is not persisted to storage, so a
// refresh on a shared terminal forces a fresh login.

function fmtWait(mins) {
  const m = Math.max(0, Number(mins) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function NursingStationPage() {
  const [tok, setTok] = useState(null);         // JWT once logged in (memory only)
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [alerts, setAlerts] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [flash, setFlash] = useState(false);     // brief highlight on a new push
  const esRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.staffAlerts();
      setAlerts(Array.isArray(res?.data) ? res.data : []);
      setLoadErr('');
    } catch (err) {
      setLoadErr(err.message || 'Could not load alerts');
    }
  }, []);

  // Once authenticated: prime the list, poll slowly, and open the live SSE stream.
  useEffect(() => {
    if (!tok) return;
    let alive = true;

    refresh();
    const poll = setInterval(refresh, 20000);

    const es = new EventSource(`/api/alerts/stream?token=${encodeURIComponent(tok)}`);
    esRef.current = es;
    es.onmessage = (e) => {
      let msg = {};
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'triage_alert') {
        // A new RED was just raised — pull the authoritative list and flash.
        refresh();
        if (alive) {
          setFlash(true);
          setTimeout(() => alive && setFlash(false), 2500);
        }
      }
    };
    // EventSource auto-reconnects; a hard error just means a gap in push (the poll
    // still covers us), so we don't tear the session down here.

    return () => {
      alive = false;
      clearInterval(poll);
      es.close();
      esRef.current = null;
    };
  }, [tok, refresh]);

  async function doLogin(e) {
    e.preventDefault();
    setLoginErr('');
    setBusy(true);
    try {
      const res = await api.staffLogin(passcode, name.trim());
      const t = res?.data?.token;
      if (!t) throw new Error('Login failed');
      setToken(t);          // so api.* calls carry the bearer token
      setTok(t);            // so the SSE effect can start
      setPasscode('');
    } catch (err) {
      setLoginErr(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function ack(sessionId) {
    // Optimistic: drop it immediately, then confirm with the server.
    setAlerts((prev) => prev.filter((a) => a.id !== sessionId));
    try {
      await api.staffAck(sessionId);
    } catch {
      refresh();            // put it back if the server rejected the ack
    }
  }

  function logout() {
    if (esRef.current) esRef.current.close();
    setToken(null);
    setTok(null);
    setAlerts([]);
    setName('');
  }

  // ── Login gate ──
  if (!tok) {
    return (
      <main style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <form onSubmit={doLogin} style={{ background: 'var(--card-bg)', padding: 32,
          borderRadius: 12, width: '100%', maxWidth: 380, border: '1px solid var(--border)' }}>
          <h1 style={{ margin: '0 0 4px', color: 'var(--text)', fontSize: 22 }}>Nursing Station</h1>
          <p style={{ margin: '0 0 20px', color: 'var(--text-light)', fontSize: 14 }}>
            Live board of urgent (RED) patients. Log in with your name and the station passcode.
          </p>
          <label style={{ display: 'block', fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>Your name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="input" style={{ width: '100%', marginBottom: 14 }} autoComplete="off" />
          <label style={{ display: 'block', fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>Station passcode</label>
          <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} required
            className="input" style={{ width: '100%', marginBottom: 18 }} autoComplete="off" />
          {loginErr && (
            <p style={{ color: 'var(--red)', fontSize: 13, margin: '0 0 14px' }}>{loginErr}</p>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy}
            style={{ width: '100%' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </main>
    );
  }

  // ── Board ──
  return (
    <main style={{ minHeight: '100vh', background: 'var(--bg)', padding: '20px 24px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, color: 'var(--text)', fontSize: 22 }}>
            Nursing Station
            <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 400, color: 'var(--text-light)' }}>
              urgent (RED) patients
            </span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--text-light)' }}>
            {flash ? '🔴 new alert' : `${alerts.length} active`}
          </span>
          <button onClick={refresh} className="btn btn-outline" style={{ padding: '6px 12px' }}>Refresh</button>
          <button onClick={logout} className="btn btn-outline" style={{ padding: '6px 12px' }}>Log out</button>
        </div>
      </header>

      {loadErr && (
        <p style={{ color: 'var(--red)', fontSize: 14 }}>{loadErr}</p>
      )}

      {alerts.length === 0 && !loadErr && (
        <div style={{ background: 'var(--card-bg)', border: '1px solid var(--border)',
          borderRadius: 10, padding: 32, textAlign: 'center', color: 'var(--text-light)' }}>
          No urgent patients right now. New RED alerts appear here automatically.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {alerts.map((a) => (
          <div key={a.id} style={{ background: 'var(--card-bg)', borderRadius: 10,
            borderLeft: '5px solid var(--red)', border: '1px solid var(--border)',
            borderLeftWidth: 5, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
                {a.token_label || '—'}
              </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', background: 'var(--red)',
                padding: '2px 8px', borderRadius: 4 }}>RED</span>
            </div>
            <div style={{ margin: '8px 0 4px', fontSize: 14, color: 'var(--text)' }}>
              {a.department || 'Unassigned dept.'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-light)' }}>
              Waiting {fmtWait(a.waited_min)}
              {a.in_consult ? ' · with doctor' : ' · in queue'}
            </div>
            <button onClick={() => ack(a.id)} className="btn btn-primary"
              style={{ marginTop: 12, width: '100%', padding: '8px 12px' }}>
              Acknowledge
            </button>
          </div>
        ))}
      </div>

      <p style={{ marginTop: 20, fontSize: 12, color: 'var(--text-light)' }}>
        Token numbers only — no patient names are shown here. Acknowledging removes a
        patient from the board once you have attended to or escalated them.
      </p>
    </main>
  );
}
