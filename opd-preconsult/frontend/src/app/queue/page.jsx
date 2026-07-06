'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '../../lib/api';

// PUBLIC waiting-room "Now Serving" board, for a screen in the waiting area.
// Usage: /queue?dept=CARD  (optional &name=Cardiology &refresh=5)
// Shows token numbers only — no patient names/PHI. Polls the public board endpoint.

const DEPT_NAMES = { CARD: 'Cardiology', GEN: 'General Medicine', ORTHO: 'Orthopedics' };
const DEPT_ACCENT = { CARD: '#E4572E', GEN: '#2E86AB', ORTHO: '#17A398' };
const TRIAGE = { RED: '#E4572E', AMBER: '#E0A82E', GREEN: '#3FA869' };

function Board() {
  const sp = useSearchParams();
  const dept = (sp.get('dept') || sp.get('department') || '').toUpperCase();
  const name = sp.get('name') || DEPT_NAMES[dept] || dept || 'Department';
  const accent = DEPT_ACCENT[dept] || '#2E86AB';
  const refreshMs = Math.max(2, parseInt(sp.get('refresh') || '5', 10)) * 1000;

  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [updated, setUpdated] = useState(null);
  const [now, setNow] = useState(null);

  // Live wall clock for the header.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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
    <div style={{
      minHeight: '100vh', color: '#EAF2F8',
      background: 'radial-gradient(1200px 700px at 15% -10%, #12405A 0%, #0B2635 55%, #081C28 100%)',
      display: 'flex', flexDirection: 'column', padding: 'clamp(20px, 3vw, 40px)',
      fontFamily: "'Noto Sans', sans-serif",
    }}>
      <style>{`@keyframes nsPulse {
        0%   { box-shadow: 0 0 0 0 rgba(255,255,255,0.20); }
        70%  { box-shadow: 0 0 0 18px rgba(255,255,255,0); }
        100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
      }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <div style={{ fontSize: 'clamp(13px, 1.4vw, 18px)', letterSpacing: 3, color: '#8FB4CB', textTransform: 'uppercase' }}>Patient Check-in</div>
          <h1 style={{ fontSize: 'clamp(30px, 4.4vw, 60px)', margin: '2px 0 0', fontWeight: 800, lineHeight: 1.05 }}>{name}</h1>
          <div style={{ height: 5, width: 96, borderRadius: 999, background: accent, marginTop: 12 }} />
        </div>
        <div style={{ textAlign: 'right', color: '#A9C6D8' }}>
          <div style={{ fontSize: 'clamp(22px, 2.4vw, 34px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {now ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
          </div>
          <div style={{ fontSize: 'clamp(11px, 1.1vw, 15px)' }}>
            {now ? now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : ''}
          </div>
        </div>
      </div>

      {err && <p style={{ color: '#ffd1cd', fontSize: 22, marginTop: 24 }}>{err}</p>}

      {/* NOW SERVING */}
      <div style={{ marginTop: 'clamp(20px, 3vh, 40px)' }}>
        <p style={{ fontSize: 'clamp(14px, 1.6vw, 20px)', letterSpacing: 3, color: '#8FB4CB', margin: '0 0 14px' }}>NOW SERVING</p>
        {serving.length === 0 ? (
          <div style={{
            borderRadius: 20, padding: 'clamp(20px, 3vh, 36px)',
            background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(143,180,203,0.35)',
            color: '#6E93A9', fontSize: 'clamp(20px, 2.4vw, 30px)', fontWeight: 600,
          }}>Waiting for the next patient…</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            {serving.map((s, i) => {
              const c = TRIAGE[s.triage_level] || accent;
              return (
                <div key={i} style={{
                  minWidth: 240, borderRadius: 20, overflow: 'hidden',
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04))',
                  border: '1px solid rgba(255,255,255,0.10)',
                  animation: 'nsPulse 2.2s ease-out infinite',
                }}>
                  <div style={{ height: 8, background: c }} />
                  <div style={{ padding: 'clamp(14px, 2vh, 26px) clamp(24px, 3vw, 40px)', textAlign: 'center' }}>
                    <div style={{ fontSize: 'clamp(44px, 7vw, 104px)', fontWeight: 900, lineHeight: 1, letterSpacing: 1 }}>{s.token_label}</div>
                    <div style={{ marginTop: 8, fontSize: 'clamp(12px, 1.3vw, 17px)', letterSpacing: 2, color: '#A9C6D8', textTransform: 'uppercase' }}>Being seen now</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* WAITING */}
      <div style={{ marginTop: 'clamp(22px, 4vh, 52px)', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <p style={{ fontSize: 'clamp(14px, 1.6vw, 20px)', letterSpacing: 3, color: '#8FB4CB', margin: 0 }}>WAITING</p>
          <span style={{ background: accent, color: '#fff', fontWeight: 800, borderRadius: 999, padding: '2px 14px', fontSize: 'clamp(14px, 1.6vw, 20px)' }}>
            {data?.waiting_count ?? 0}
          </span>
        </div>
        {waiting.length === 0 ? (
          <p style={{ fontSize: 'clamp(16px, 2vw, 24px)', color: '#6E93A9' }}>No one is waiting right now.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
            {waiting.slice(0, 24).map((w, i) => {
              const c = TRIAGE[w.triage_level] || '#5b7e92';
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center',
                  fontSize: 'clamp(20px, 2.6vw, 36px)', fontWeight: 800,
                  padding: 'clamp(10px, 1.6vh, 18px) 12px', borderRadius: 14,
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                  borderLeft: `6px solid ${c}`,
                }}>
                  {w.token_label}
                </div>
              );
            })}
            {waiting.length > 24 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'clamp(18px, 2vw, 28px)', color: '#8FB4CB' }}>
                +{waiting.length - 24} more
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid rgba(143,180,203,0.25)', paddingTop: 12, marginTop: 20,
        display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, color: '#7ea7bd', fontSize: 'clamp(11px, 1.1vw, 15px)' }}>
        <span>⚠️ Urgent cases may be seen first.</span>
        <span>{updated ? 'Updated ' + updated.toLocaleTimeString() : 'Loading…'}</span>
      </div>
    </div>
  );
}

export default function QueueBoardPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#0B2635', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>Loading…</div>}>
      <Board />
    </Suspense>
  );
}
