'use client';
import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, setToken } from '../lib/api';
import { t } from '../lib/i18n';
import QRScanner from '../components/QRScanner';

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [lang, setLang] = useState('en');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  // When the patient opens a kiosk QR URL (?qr=...) we hold the payload here
  // instead of processing it immediately. The QR is only scanned once the patient
  // taps their language — so they always see the welcome screen and make a language
  // choice before the session is created.
  const [pendingQr, setPendingQr] = useState(null);
  // True once the patient has an active session this visit (e.g. they tapped Back
  // from the form to change language). Lets a language tap send them onward instead
  // of dead-ending when the ?qr= param is no longer in the URL.
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    // Optional ?lang=hi|te|en lets a bypass link jump straight into a language.
    const urlLang = searchParams.get('lang');
    if (urlLang && ['en', 'hi', 'te'].includes(urlLang)) setLang(urlLang);
    const qr = searchParams.get('qr');
    // A QR in the URL is a FRESH kiosk scan → it must start a brand-new session,
    // never reuse a token left over from a previous patient on this (shared) device.
    // Only when there's NO new QR but a token exists do we treat it as the patient
    // returning from the form (Back to change language) and reuse that session.
    let storedQr = null, hasTok = false;
    try { storedQr = sessionStorage.getItem('qr'); hasTok = !!sessionStorage.getItem('token'); } catch {}
    if (qr) {
      setPendingQr(qr);
      setHasSession(false);            // fresh scan — do not reuse any old session
    } else if (hasTok) {
      setHasSession(true);             // returned from the form — reuse the session
      setPendingQr(storedQr);
    } else if (storedQr) {
      setPendingQr(storedQr);
      setHasSession(false);
    }
  }, [searchParams]);

  // Clear every trace of a previous patient on this (possibly shared kiosk)
  // browser, so a new scan never inherits an old session_id, OTP-verified flag,
  // form draft, or welcome card — which is what made the interview skip questions
  // and jump straight to vitals.
  function clearPatientState() {
    ['token', 'session_id', 'department', 'qr', 'otp_verified', 'register_form', 'welcome_back']
      .forEach(k => { try { sessionStorage.removeItem(k); } catch {} });
    setToken(null);
  }

  // Picking a language is the "proceed" action on a kiosk. A fresh URL QR always
  // scans a NEW session; otherwise, if a session exists (returned from the form),
  // reuse it; otherwise scan the remembered QR.
  function pickLang(code) {
    setLang(code);
    try { sessionStorage.setItem('lang', code); } catch {}
    const urlQr = searchParams.get('qr');
    if (urlQr) {
      handleQR(urlQr, code);               // fresh kiosk QR → new session, clean slate
    } else if (hasSession) {
      router.push('/patient/register');    // returned from the form — reuse session
    } else if (pendingQr) {
      handleQR(pendingQr, code);           // remembered QR, no live session → new one
    }
    // else: direct visit, no session yet — language just updates; use the Scan button.
  }

  async function handleQR(payload, langOverride) {
    setShowScanner(false);
    setLoading(true);
    setError('');
    try {
      const result = await api.scan(payload);
      // A successful scan = a new visit. Wipe any previous patient's state FIRST so
      // nothing leaks into this session, then write the fresh session's values.
      clearPatientState();
      setToken(result.token);
      sessionStorage.setItem('token', result.token);
      sessionStorage.setItem('session_id', result.session.id);
      sessionStorage.setItem('department', result.session.department);
      // Remember the QR payload so the flow can transparently re-mint a session
      // if the server-side one is missing (e.g. DB reset) instead of dead-ending.
      sessionStorage.setItem('qr', payload);
      const chosen = (langOverride && ['en', 'hi', 'te'].includes(langOverride)) ? langOverride : lang;
      sessionStorage.setItem('lang', chosen);
      router.push('/patient/register');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="screen">
      {showScanner && (
        <QRScanner onScan={handleQR} onClose={() => setShowScanner(false)} />
      )}

      <div className="card" style={{ justifyContent: 'center', alignItems: 'center', gap: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 48 }}>🏥</div>
        <h1 style={{ fontSize: 24, color: 'var(--primary)' }}>{t('welcome', lang)}</h1>
        <p style={{ color: 'var(--text-light)' }}>{t('scan_prompt', lang)}</p>

        <div className="lang-selector">
          {[['en', 'English'], ['hi', 'हिंदी'], ['te', 'తెలుగు']].map(([code, label]) => (
            <button
              key={code}
              className={`lang-btn ${lang === code ? 'active' : ''}`}
              onClick={() => pickLang(code)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* When a kiosk QR is pending (or a session already exists from an earlier
            scan this visit), language selection IS the proceed action — show a hint
            instead of the camera button to avoid confusing the patient. */}
        {(pendingQr || hasSession) ? (
          <p style={{ color: 'var(--text-light)', fontSize: 14, fontWeight: 500 }}>
            {lang === 'hi' ? '👆 अपनी भाषा चुनें' : lang === 'te' ? '👆 మీ భాషను ఎంచుకోండి' : '👆 Tap your language to continue'}
          </p>
        ) : (
          /* Camera scan button — primary CTA for in-app scanning */
          <button
            className="btn btn-primary"
            style={{ fontSize: 18, padding: '16px 24px', gap: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setShowScanner(true)}
            disabled={loading}
          >
            📷 {lang === 'hi' ? 'QR कोड स्कैन करें' : lang === 'te' ? 'QR కోడ్ స్కాన్ చేయండి' : 'Scan QR Code'}
          </button>
        )}

        {/* Manual entry for demo/fallback */}
        <details style={{ width: '100%' }}>
          <summary style={{ fontSize: 12, color: 'var(--text-light)', cursor: 'pointer', marginBottom: 8 }}>
            Enter QR code manually
          </summary>
          <input className="input" placeholder="Base64 QR payload" id="qr-input" />
          <button
            className="btn btn-outline"
            style={{ marginTop: 8, fontSize: 14 }}
            disabled={loading}
            onClick={() => {
              const val = document.getElementById('qr-input').value;
              if (val) handleQR(val);
            }}
          >
            {loading ? 'Loading...' : 'Start Session'}
          </button>
        </details>

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
