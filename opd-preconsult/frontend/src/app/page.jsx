'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, setToken } from '../lib/api';
import { t } from '../lib/i18n';

// Legacy kiosk QRs were base64(JSON). Decode defensively — a malformed payload
// just means we can't proceed, never a thrown render.
function decodePayload(b64) {
  try { return JSON.parse(atob(b64)); } catch { return null; }
}
function encodePayload(obj) { return btoa(JSON.stringify(obj)); }

// Single-tenant default when a QR/URL doesn't name a hospital. Overridable at
// build time via NEXT_PUBLIC_HOSPITAL_ID.
const DEFAULT_HOSPITAL_ID = process.env.NEXT_PUBLIC_HOSPITAL_ID || 'demo_hospital_01';

// Resolve a scanned/opened value into { hospitalId, department }. Accepts, in
// order of preference: a plain-URL QR (recommended) carrying ?h= (or legacy
// ?qr=), a bare query string, or a legacy base64 payload. A plain domain QR with
// no hospital hint falls back to the default hospital (single-tenant deployments).
function parseEntry(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let hVal = null, qrVal = null, wasUrl = false;
  if (/^https?:\/\//i.test(s)) {
    wasUrl = true;
    try { const u = new URL(s); hVal = u.searchParams.get('h'); qrVal = u.searchParams.get('qr'); } catch {}
  } else if (/(^|[?&])(h|qr)=/.test(s)) {
    try { const u = new URLSearchParams(s.replace(/^\?/, '')); hVal = u.get('h'); qrVal = u.get('qr'); } catch {}
  }
  if (qrVal) {
    const d = decodePayload(qrVal);
    if (d?.hospital_id) return { hospitalId: d.hospital_id, department: d.department || null };
  }
  if (hVal) return { hospitalId: hVal, department: null };
  // Legacy: the raw value is itself the base64 payload.
  const d = decodePayload(s);
  if (d?.hospital_id) return { hospitalId: d.hospital_id, department: d.department || null };
  // A plain domain QR with no hint → single-tenant default.
  if (wasUrl) return { hospitalId: DEFAULT_HOSPITAL_ID, department: null };
  return null;
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [lang, setLang] = useState('en');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // The resolved entry (from ?h= / ?qr= / default) held until the patient taps a
  // language, so they always see the welcome screen and make a language choice
  // before the session is created. The DEPARTMENT is no longer chosen here — it's
  // picked later in the form, after OTP + details.
  const [pendingQr, setPendingQr] = useState(null);
  // True once the patient has an active session this visit (e.g. they tapped Back
  // from the form to change language). Lets a language tap send them onward.
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const urlLang = searchParams.get('lang');
    if (urlLang && ['en', 'hi', 'te'].includes(urlLang)) setLang(urlLang);
    const qr = searchParams.get('qr');
    const h = searchParams.get('h');
    // A QR/URL param is a FRESH kiosk scan → start a brand-new session, never reuse
    // a token left over from a previous patient on this (shared) device. Only when
    // there's NO new entry param but a token exists do we treat it as the patient
    // returning from the form and reuse that session.
    let storedQr = null, tok = null, sid = null;
    try {
      storedQr = sessionStorage.getItem('qr');
      tok = sessionStorage.getItem('token');
      sid = sessionStorage.getItem('session_id');
    } catch {}
    if (qr) {
      setPendingQr(qr);
      setHasSession(false);
    } else if (h) {
      setPendingQr(`h=${encodeURIComponent(h)}`);
      setHasSession(false);
    } else if (tok && sid) {
      // A token in sessionStorage is not proof of a LIVE session — the secret may
      // have rotated (a redeploy invalidates every issued token), it may have
      // expired, or the session may be gone server-side. Reusing it unchecked
      // carried a dead token into the flow, where the first authed call 401s and
      // the screen just looks frozen. Verify it once, and fall back to a fresh
      // entry if it no longer works, so the patient never reaches that dead end.
      setToken(tok);
      setPendingQr(storedQr);
      api.getSession(sid)
        .then(() => { if (!cancelled) setHasSession(true); })
        .catch(() => {
          if (cancelled) return;
          clearPatientState();
          setHasSession(false);
          // Reuse the stored entry only if it still resolves to a hospital: a stale
          // or malformed value would fail parseEntry on every language tap, leaving
          // the patient stuck here with no way forward. The single-tenant default
          // always resolves.
          setPendingQr(parseEntry(storedQr) ? storedQr : `h=${encodeURIComponent(DEFAULT_HOSPITAL_ID)}`);
        });
    } else if (storedQr && parseEntry(storedQr)) {
      // Same guard as the validation fallback above: only carry the stored entry
      // forward if it still resolves to a hospital, otherwise every language tap
      // dead-ends on "session expired" with no way to start over.
      setPendingQr(storedQr);
      setHasSession(false);
    } else {
      // Bare visit → single-tenant default so language → form always works.
      setPendingQr(`h=${encodeURIComponent(DEFAULT_HOSPITAL_ID)}`);
      setHasSession(false);
    }
    return () => { cancelled = true; };
  }, [searchParams]);

  // Clear every trace of a previous patient on this (possibly shared kiosk)
  // browser, so a new scan never inherits an old session_id, OTP-verified flag,
  // form draft, or welcome card.
  function clearPatientState() {
    ['token', 'session_id', 'department', 'qr', 'otp_verified', 'register_form', 'welcome_back', 'register_progress']
      .forEach(k => { try { sessionStorage.removeItem(k); } catch {} });
    setToken(null);
  }

  // Tapping a language is the proceed action. Fresh entry → create a session and go
  // to the form; a live session (returned from the form) → just reuse it.
  function pickLang(code) {
    setLang(code);
    try { sessionStorage.setItem('lang', code); } catch {}
    if (hasSession) {
      router.push('/patient/consent');
    } else if (pendingQr) {
      beginEntry(pendingQr, code);
    }
  }

  // Create the session for this hospital (NO department — that's chosen in the
  // form now) and route to registration.
  function beginEntry(rawPayload, langOverride) {
    setError('');
    const parsed = parseEntry(rawPayload);
    if (!parsed || !parsed.hospitalId) {
      setError(t('err_session_expired', langOverride || lang));
      return;
    }
    createSession(encodePayload({ hospital_id: parsed.hospitalId }), langOverride);
  }

  async function createSession(payload, langOverride) {
    setLoading(true);
    setError('');
    try {
      const result = await api.scan(payload);
      // A successful scan = a new visit. Wipe any previous patient's state FIRST,
      // then write the fresh session's values.
      clearPatientState();
      setToken(result.token);
      sessionStorage.setItem('token', result.token);
      sessionStorage.setItem('session_id', result.session.id);
      sessionStorage.setItem('qr', payload);
      const chosen = (langOverride && ['en', 'hi', 'te'].includes(langOverride)) ? langOverride : lang;
      sessionStorage.setItem('lang', chosen);
      router.push('/patient/consent');
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  // ── Welcome / language screen ──
  // The patient reaches this by scanning the hospital poster QR with their phone
  // camera (which opens the app at ?h=<hospital_id>). Tapping a language creates
  // the session and moves to the form (phone → OTP → details → department).
  return (
    <div className="screen">
      <div className="card" style={{ justifyContent: 'center', alignItems: 'center', gap: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🏥</div>
        <h1 style={{ fontSize: 24, color: 'var(--primary)' }}>{t('welcome', lang)}</h1>
        <p style={{ color: 'var(--text-light)' }}>{t('choose_language', lang)}</p>

        <div className="lang-selector">
          {[['en', 'English'], ['hi', 'हिंदी'], ['te', 'తెలుగు']].map(([code, label]) => (
            <button
              key={code}
              className={`lang-btn ${lang === code ? 'active' : ''}`}
              onClick={() => pickLang(code)}
              disabled={loading}
            >
              {label}
            </button>
          ))}
        </div>

        <p style={{ color: 'var(--text-light)', fontSize: 14, fontWeight: 500 }}>
          {lang === 'hi' ? '👆 अपनी भाषा चुनें' : lang === 'te' ? '👆 మీ భాషను ఎంచుకోండి' : '👆 Tap your language to continue'}
        </p>

        {error && <p style={{ color: 'var(--red)', fontSize: 14 }}>{error}</p>}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<div className="screen" style={{ justifyContent: 'center', alignItems: 'center' }}><p>Loading...</p></div>}>
      <HomeContent />
    </Suspense>
  );
}
