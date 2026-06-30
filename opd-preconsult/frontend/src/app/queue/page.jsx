'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';

// PUBLIC waiting-room "Now Serving" board, meant for a screen in the waiting area.
// Usage: /queue?dept=CARD  (optional &name=Cardiology &refresh=5)
// Shows token numbers only — no patient names/PHI. Polls the public board endpoint.

const DEPT_NAMES = { CARD: 'Cardiology', GEN: 'General Medicine', ORTHO: 'Orthopedics' };
const TRIAGE_BG = { RED: '#D9544D', AMBER: '#E0A82E', GREEN: '#3FA869' };

function Board() {
  const sp = useSearchParams();
  const dept = (sp.get('dept') || sp.get('department') || '').toUpperCase();
  const name = sp.get('name') || DEPT_NAMES[dept] || dept || 'Department';
  const refreshMs = Math.max(2, parseInt(sp.get('refresh') || '5', 10)) * 1000;

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState(null);

  useEffect(() => {
    if (!dept) { setErr('Add ?dept=CARD to the URL'); return; }
    let alive = true;
    async function load() {
      try {
        const d = await api.queueBoard(dept);
        if (!alive) return;
        setData(d); setErr(''); setUpdated(new Date());
      } catch (e) {
        if (alive) setErr(e.message || 'Could not load board');
      }
    }
    load();
    const id = setInterval(load, refreshMs);
    return () => { alive = false; clearInterval(id); };
  }, [dept, refreshMs]);

  const serving = data?.now_serving || [];
  const waiting = data?.waiting || [];

  return (
    <div style={{ minHeight: '100vh', background: '#0E2A3B', color: '#fff',
      display: 'flex', flexDirection: 'column', padding: '32px 40px', fontFamily: "'Noto Sans', sans-serif" }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '2px solid #2E86AB', paddingBottom: 16 }}>
        <h1 style={{ fontSize: 'clamp(28px, 4vw, 52px)', margin: 0 }}>🏥 {name}</h1>
        <span style={{ fontSize: 'clamp(14px, 1.5vw, 20px)', color: '#9fc4d8' }}>Patient Check-in Queue</span>
      </div>

      {err && <p style={{ color: '#ffd1cd', fontSize: 22, marginTop: 24 }}>{err}</p>}

      {/* NOW SERVING */}
      <div style={{ marginTop: 28 }}>
        <p style={{ fontSize: 'clamp(16px, 2vw, 24px)', letterSpacing: 2, color: '#9fc4d8', marginBottom: 12 }}>NOW SERVING</p>
        {serving.length === 0 ? (
          <p style={{ fontSize: 'clamp(40px, 7vw, 96px)', fontWeight: 800, margin: 0, color: '#5b7e92' }}>—</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
            {serving.map((s, i) => (
              <span key={i} style={{
                fontSize: 'clamp(40px, 7vw, 96px)', fontWeight: 800, lineHeight: 1.05,
                padding: '4px 28px', borderRadius: 16,
                background: TRIAGE_BG[s.triage_level] || '#1B6CA8', color: '#fff',
              }}>{s.token_label}</span>
            ))}
          </div>
        )}
      </div>

      {/* WAITING */}
      <div style={{ marginTop: 'clamp(24px, 4vh, 56px)', flex: 1 }}>
        <p style={{ fontSize: 'clamp(16px, 2vw, 24px)', letterSpacing: 2, color: '#9fc4d8', marginBottom: 16 }}>
          WAITING · {data?.waiting_count ?? 0}
        </p>
        {waiting.length === 0 ? (
          <p style={{ fontSize: 22, color: '#5b7e92' }}>No one is waiting right now.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {waiting.slice(0, 18).map((w, i) => (
              <span key={i} style={{
                fontSize: 'clamp(22px, 3vw, 40px)', fontWeight: 700,
                padding: '8px 20px', borderRadius: 12,
                background: '#16384C', color: '#eaf1f6',
                border: `3px solid ${TRIAGE_BG[w.triage_level] || '#2E86AB'}`,
              }}>{w.token_label}</span>
            ))}
            {waiting.length > 18 && (
              <span style={{ fontSize: 'clamp(22px, 3vw, 40px)', alignSelf: 'center', color: '#9fc4d8' }}>
                +{waiting.length - 18} more
              </span>
            )}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid #2E86AB', paddingTop: 12, display: 'flex', justifyContent: 'space-between', color: '#7ea7bd', fontSize: 14 }}>
        <span>Urgent cases may be seen first. ⚠️ Investigational — not for clinical use.</span>
        <span>{updated ? 'Updated ' + updated.toLocaleTimeString() : 'Loading…'}</span>
      </div>
    </div>
  );
}

export default function QueueBoardPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#0E2A3B', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>Loading…</div>}>
      <Board />
    </Suspense>
  );
}
