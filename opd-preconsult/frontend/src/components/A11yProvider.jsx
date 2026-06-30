'use client';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Accessibility controls for the PATIENT-facing flow (elderly / low-literacy):
//   • Text size  A / A+ / A++   — scales font + tap targets via the --fs variable
//     (font-scaling, not zoom, so it reflows within the phone's width).
//   • Assisted mode             — one switch: max font + high-contrast theme
//     (the `assist` class) + auto-read-aloud of prompts (ListenButton autoPlay).
// Only active on patient routes; doctor/HIS stay at 1x. Both persist in localStorage.
const SIZES = [['A', 1], ['A+', 1.15], ['A++', 1.3]];
const ASSIST_FS = 1.3;

export default function A11yProvider({ children }) {
  const pathname = usePathname() || '/';
  const isPatient = pathname === '/' || pathname.startsWith('/patient');
  const [scale, setScale] = useState(1);
  const [assist, setAssist] = useState(false);

  useEffect(() => {
    const s = parseFloat(localStorage.getItem('fontScale') || '1');
    if (s && s >= 1 && s <= 1.6) setScale(s);
    setAssist(localStorage.getItem('assistMode') === '1');
  }, []);

  // Apply font multiplier + high-contrast class on the document root. Assisted
  // mode forces max font. Non-patient routes always render plain (1x, no assist).
  useEffect(() => {
    const fs = !isPatient ? 1 : (assist ? ASSIST_FS : scale);
    document.documentElement.style.setProperty('--fs', String(fs));
    document.documentElement.classList.toggle('assist', isPatient && assist);
    // Reserve a top strip for the fixed bar so it never overlaps page content
    // (on a phone the centered card spans nearly the full width and would sit
    // under the bar). Only on patient routes, where the bar is rendered.
    document.body.classList.toggle('has-a11y-bar', isPatient);
    // Let auto-read-aware components (e.g. QuestionCard) react.
    window.dispatchEvent(new CustomEvent('assistchange', { detail: isPatient && assist }));
  }, [scale, assist, isPatient]);

  function pickSize(val) {
    setScale(val);
    try { localStorage.setItem('fontScale', String(val)); } catch {}
  }
  function toggleAssist() {
    setAssist(a => {
      const next = !a;
      try { localStorage.setItem('assistMode', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  if (!isPatient) return <>{children}</>;

  return (
    <>
      <div style={{
        position: 'fixed', top: 8, right: 10, zIndex: 70,
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap',
        maxWidth: 'calc(100vw - 20px)', whiteSpace: 'nowrap',
        background: '#fff', border: '1px solid #e0e6ec', borderRadius: 22,
        padding: '4px 10px', boxShadow: '0 1px 5px rgba(0,0,0,0.12)',
      }}>
        <span style={{ fontSize: 12, color: 'var(--text-light)', fontWeight: 600 }}>Text</span>
        {SIZES.map(([labelTxt, val]) => (
          <button
            key={labelTxt}
            type="button"
            onClick={() => pickSize(val)}
            aria-label={'Text size ' + labelTxt}
            aria-pressed={!assist && scale === val}
            disabled={assist}
            style={{
              border: 'none', cursor: assist ? 'default' : 'pointer', borderRadius: 12, padding: '2px 8px',
              fontWeight: 700, opacity: assist ? 0.4 : 1,
              fontSize: labelTxt === 'A' ? 12 : labelTxt === 'A+' ? 14 : 16,
              background: (!assist && scale === val) ? 'var(--primary)' : '#eef2f6',
              color: (!assist && scale === val) ? '#fff' : 'var(--text)',
            }}
          >
            {labelTxt}
          </button>
        ))}
        <span style={{ width: 1, height: 18, background: '#e0e6ec' }} />
        <button
          type="button"
          onClick={toggleAssist}
          aria-pressed={assist}
          style={{
            border: 'none', cursor: 'pointer', borderRadius: 14, padding: '4px 10px',
            fontWeight: 700, fontSize: 12,
            background: assist ? 'var(--accent)' : '#eef2f6',
            color: assist ? 'var(--primary)' : 'var(--text)',
          }}
        >
          ♿ Assist{assist ? ' ✓' : ''}
        </button>
      </div>
      {children}
    </>
  );
}
