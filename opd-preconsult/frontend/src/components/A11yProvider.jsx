'use client';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { installGlobalErrorReporting } from '../lib/errorReport';

// Accessibility controls, in two flavours keyed off the route.
//
// PATIENT flow (elderly / low-literacy, on a phone):
//   • Text size  A / A+ / A++   — scales font + tap targets via the --fs variable
//   • Assisted mode             — one switch: max font + high-contrast theme
//     (the `assist` class) + auto-read-aloud of prompts (ListenButton autoPlay).
//
// DOCTOR / HIS dashboards (desktop, dense, sub-12px type everywhere):
//   • Text size  100 / 115 / 130 / 150 %  — same --fs variable, no assist mode.
//
// Both scale FONTS, never page zoom. Zoom was the obvious shortcut and it is
// wrong here: the doctor shell is `height: 100vh; overflow: hidden`, so scaling
// the root would make the shell 1.5 viewports tall and clip it. Scaling type lets
// text reflow inside panes that already scroll. This is why every inline
// `fontSize` in doctor/page.jsx and his/page.jsx reads `calc(Npx * var(--fs))` —
// keep new ones in that form or they will silently ignore the control.
//
// Browser zoom (Ctrl +/-) still works on top of this and is what carries the app
// to the 200% required by WCAG SC 1.4.4; this control is the in-app affordance.
const SIZES = [['A', 1], ['A+', 1.15], ['A++', 1.3]];
const DASH_SIZES = [['100%', 1], ['115%', 1.15], ['130%', 1.3], ['150%', 1.5]];
const ASSIST_FS = 1.3;

const BAR_BASE = {
  position: 'fixed',
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap',
  maxWidth: 'calc(100vw - 20px)', whiteSpace: 'nowrap',
  background: '#fff', border: '1px solid #e0e6ec', borderRadius: 22,
  padding: '4px 10px', boxShadow: '0 1px 5px rgba(0,0,0,0.12)',
};
// Patient: top-right, with body padding reserving the strip (see globals.css).
const BAR_STYLE = { ...BAR_BASE, top: 8, right: 10, zIndex: 70 };
// Dashboards: bottom-right and floating — the doctor shell is `height: 100vh;
// overflow: hidden`, so reserving a top strip would push its sticky sidebar past
// the fold. zIndex sits below the HIS drawer (51) and every modal (60/100/200) so
// an open dialog covers the pill rather than the pill hovering over the dialog.
const DASH_BAR_STYLE = { ...BAR_BASE, bottom: 12, right: 12, zIndex: 45 };

export default function A11yProvider({ children }) {
  const pathname = usePathname() || '/';
  const isPatient = pathname === '/' || pathname.startsWith('/patient');
  const isDashboard = pathname.startsWith('/doctor') || pathname.startsWith('/his');

  const [scale, setScale] = useState(1);
  const [dashScale, setDashScale] = useState(1);
  const [assist, setAssist] = useState(false);

  useEffect(() => {
    const s = parseFloat(localStorage.getItem('fontScale') || '1');
    if (s && s >= 1 && s <= 1.6) setScale(s);
    const d = parseFloat(localStorage.getItem('dashFontScale') || '1');
    if (d && d >= 1 && d <= 1.6) setDashScale(d);
    setAssist(localStorage.getItem('assistMode') === '1');
    // This provider wraps the whole app and is the first client code to run, so it
    // is where the browser-wide error listeners go. No-op unless SENTRY_DSN is set
    // on the backend; never affects what the user sees. See lib/errorReport.js.
    installGlobalErrorReporting();
  }, []);

  // Apply font multiplier + high-contrast class on the document root. Assisted
  // mode forces max font. Routes with no control (e.g. the waiting-room board)
  // always render plain at 1x.
  useEffect(() => {
    let fs = 1;
    if (isPatient) fs = assist ? ASSIST_FS : scale;
    else if (isDashboard) fs = dashScale;

    document.documentElement.style.setProperty('--fs', String(fs));
    document.documentElement.classList.toggle('assist', isPatient && assist);
    // Reserve a top strip for the patient bar so it never overlaps the card. The
    // dashboard bar floats bottom-right and needs no reserve.
    document.body.classList.toggle('has-a11y-bar', isPatient);
    // Let auto-read-aware components (e.g. QuestionCard) react.
    window.dispatchEvent(new CustomEvent('assistchange', { detail: isPatient && assist }));
  }, [scale, dashScale, assist, isPatient, isDashboard]);

  // Keep <html lang> in step with the language the patient picked, so a screen
  // reader switches voice instead of reading Devanagari or Telugu with English
  // pronunciation. Server-rendered as "en"; corrected here on every navigation.
  useEffect(() => {
    if (!isPatient) { document.documentElement.lang = 'en'; return; }
    try {
      document.documentElement.lang = sessionStorage.getItem('lang') || 'en';
    } catch { /* sessionStorage unavailable — keep the served default */ }
  }, [isPatient, pathname]);

  function pickSize(val) {
    setScale(val);
    try { localStorage.setItem('fontScale', String(val)); } catch {}
  }
  function pickDashSize(val) {
    setDashScale(val);
    try { localStorage.setItem('dashFontScale', String(val)); } catch {}
  }
  function toggleAssist() {
    setAssist(a => {
      const next = !a;
      try { localStorage.setItem('assistMode', next ? '1' : '0'); } catch {}
      return next;
    });
  }

  if (isDashboard) {
    return (
      <>
        <div style={DASH_BAR_STYLE} role="group" aria-label="Text size">
          <span style={{ fontSize: 12, color: 'var(--text-light)', fontWeight: 600 }}>Text</span>
          {DASH_SIZES.map(([labelTxt, val]) => (
            <button
              key={labelTxt}
              type="button"
              onClick={() => pickDashSize(val)}
              aria-label={'Text size ' + labelTxt}
              aria-pressed={dashScale === val}
              style={{
                border: 'none', cursor: 'pointer', borderRadius: 12, padding: '3px 8px',
                fontWeight: 700, fontSize: 12,
                background: dashScale === val ? 'var(--primary)' : '#eef2f6',
                color: dashScale === val ? '#fff' : 'var(--text)',
              }}
            >
              {labelTxt}
            </button>
          ))}
        </div>
        {children}
      </>
    );
  }

  if (!isPatient) return <>{children}</>;

  return (
    <>
      <div style={BAR_STYLE}>
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
