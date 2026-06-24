'use client';
import { useState, useEffect } from 'react';
import RxDocument from '../../../components/RxDocument';

// Public digital prescription page. The doctor's QR encodes a link to here with
// the signed payload in the `d` query param. We verify the signature via the
// /api/prescription/verify-qr endpoint and render it with the hospital's
// configured template (branding/theme/toggles, fetched from /template).
//
// We read window.location.search directly (client-only) instead of
// useSearchParams() to avoid the App Router Suspense requirement.
export default function VerifyRx() {
  const [state, setState] = useState({ loading: true });
  const [template, setTemplate] = useState(null);

  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get('d');
    // Hospital template (branding/theme/toggles) — public; defaults if it fails.
    fetch('/api/prescription/template').then(r => r.json()).then(setTemplate).catch(() => setTemplate({}));

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

  const wrap = { minHeight: '100vh', background: '#f1f5f9', display: 'flex', justifyContent: 'center', padding: 16 };
  const card = { background: '#fff', borderRadius: 14, padding: 24, maxWidth: 460, width: '100%', boxShadow: '0 4px 20px rgba(0,0,0,.08)', height: 'fit-content' };

  if (state.loading || template === null) {
    return <div style={wrap}><div style={card}><p style={{ textAlign: 'center', color: '#64748b', fontFamily: 'Arial' }}>Verifying prescription…</p></div></div>;
  }

  if (state.error) {
    return <div style={wrap}><div style={card}>
      <p style={{ textAlign: 'center', color: '#dc2626', fontWeight: 600, fontFamily: 'Arial' }}>⚠ {state.error}</p>
    </div></div>;
  }

  if (!state.valid) {
    return <div style={wrap}><div style={card}>
      <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: 16, textAlign: 'center', fontFamily: 'Arial' }}>
        <p style={{ fontSize: 32 }}>⛔</p>
        <p style={{ color: '#b91c1c', fontWeight: 700, fontSize: 16 }}>Invalid / Unverified Prescription</p>
        <p style={{ color: '#b91c1c', fontSize: 13, marginTop: 4 }}>
          {state.error || 'The signature does not match. Do not dispense.'}
        </p>
      </div>
    </div></div>;
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <RxDocument rx={state.prescription || {}} template={template} verified={true} />
      </div>
    </div>
  );
}
