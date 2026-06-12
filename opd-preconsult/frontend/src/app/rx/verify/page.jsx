'use client';
import { useState, useEffect } from 'react';

// "2026-06-12" -> "12 Jun 2026" (readable, and avoids the ISO hyphens wrapping)
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Full ISO timestamp -> "23:47" (24h, hours + minutes, in the viewer's timezone)
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Public digital prescription page. The doctor's QR encodes a link to here with
// the signed payload in the `d` query param. We verify the signature via the
// existing /api/prescription/verify-qr endpoint and render the prescription.
//
// We read window.location.search directly (client-only) instead of
// useSearchParams() to avoid the App Router Suspense requirement.
export default function VerifyRx() {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get('d');
    if (!d) { setState({ loading: false, error: 'No prescription data in this link.' }); return; }
    fetch('/api/prescription/verify-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qr_payload: d }),
    })
      .then(r => r.json())
      .then(data => setState({ loading: false, ...data }))
      .catch(() => setState({ loading: false, error: 'Could not reach the server to verify this prescription.' }));
  }, []);

  const wrap = { minHeight: '100vh', background: '#f1f5f9', display: 'flex', justifyContent: 'center', padding: 16, fontFamily: 'Arial, sans-serif' };
  const card = { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 460, width: '100%', boxShadow: '0 4px 20px rgba(0,0,0,.08)', height: 'fit-content' };

  if (state.loading) {
    return <div style={wrap}><div style={card}><p style={{ textAlign: 'center', color: '#64748b' }}>Verifying prescription…</p></div></div>;
  }

  if (state.error) {
    return <div style={wrap}><div style={card}>
      <p style={{ textAlign: 'center', color: '#dc2626', fontWeight: 600 }}>⚠ {state.error}</p>
    </div></div>;
  }

  // Signature failed verification — tampered or invalid.
  if (!state.valid) {
    return <div style={wrap}><div style={card}>
      <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: 16, textAlign: 'center' }}>
        <p style={{ fontSize: 32 }}>⛔</p>
        <p style={{ color: '#b91c1c', fontWeight: 700, fontSize: 16 }}>Invalid / Unverified Prescription</p>
        <p style={{ color: '#b91c1c', fontSize: 13, marginTop: 4 }}>
          {state.error || 'The signature does not match. Do not dispense.'}
        </p>
      </div>
    </div></div>;
  }

  const rx = state.prescription || {};
  const items = rx.items || [];

  return (
    <div style={wrap}>
      <div style={card}>
        {/* Verified badge */}
        <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <span style={{ fontSize: 22 }}>✅</span>
          <div>
            <p style={{ color: '#047857', fontWeight: 700, fontSize: 14 }}>Verified prescription</p>
            <p style={{ color: '#059669', fontSize: 11 }}>Signature valid · issued by the hospital</p>
          </div>
        </div>

        {/* Patient + date */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <p style={{ fontSize: 17, fontWeight: 700, color: '#0f172a', margin: 0 }}>{rx.patient || 'Patient'}</p>
          <p style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap', margin: 0, textAlign: 'right' }}>
            {formatDate(rx.issued_at || rx.date)}
            {rx.issued_at && <><br /><span style={{ fontSize: 11 }}>{formatTime(rx.issued_at)}</span></>}
          </p>
        </div>

        {/* Prescribing doctor */}
        {(rx.doctor || rx.department) && (
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>
            Prescribed by <strong style={{ color: '#334155' }}>{rx.doctor || 'Doctor'}</strong>
            {rx.department ? ` · ${rx.department} Department` : ''}
          </p>
        )}

        {/* Medications */}
        <p style={{ fontSize: 13, fontWeight: 700, color: '#1c5d8c', marginBottom: 6 }}>℞ Medications</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: '6px 4px', color: '#64748b' }}>Drug</th>
              <th style={{ textAlign: 'left', padding: '6px 4px', color: '#64748b' }}>Dose</th>
              <th style={{ textAlign: 'left', padding: '6px 4px', color: '#64748b' }}>Freq</th>
              <th style={{ textAlign: 'left', padding: '6px 4px', color: '#64748b' }}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '8px 4px', fontWeight: 600 }}>
                  {it.drug || '—'}
                  {it.instructions && (
                    <div style={{ fontWeight: 400, fontSize: 11, color: '#64748b', marginTop: 2 }}>{it.instructions}</div>
                  )}
                </td>
                <td style={{ padding: '8px 4px' }}>{it.dose || '—'}</td>
                <td style={{ padding: '8px 4px' }}>{it.freq || '—'}</td>
                <td style={{ padding: '8px 4px' }}>{it.duration || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Doctor's advice & instructions */}
        {rx.notes && (
          <div style={{ marginTop: 18, borderTop: '1px solid #e2e8f0', paddingTop: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#1c5d8c', marginBottom: 4 }}>Doctor's Advice &amp; Instructions</p>
            <p style={{ fontSize: 13, color: '#334155', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{rx.notes}</p>
          </div>
        )}

        <div style={{ marginTop: 20, textAlign: 'center', borderTop: '1px solid #f1f5f9', paddingTop: 10 }}>
          <p style={{ fontSize: 10, color: '#cbd5e1', fontFamily: 'monospace', marginBottom: 4 }}>Rx ID: {rx.rx_id || '—'}</p>
          <p style={{ fontSize: 10, color: '#94a3b8' }}>
            OPD Pre-Consultation · Digital prescription. Verify physical signature before dispensing.
          </p>
        </div>
      </div>
    </div>
  );
}
