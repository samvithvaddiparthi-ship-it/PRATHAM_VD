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

  useEffect(() => {
    // Optional ?lang=hi|te|en lets a bypass link jump straight into a language.
    const urlLang = searchParams.get('lang');
    if (urlLang && ['en', 'hi', 'te'].includes(urlLang)) setLang(urlLang);
    const qr = searchParams.get('qr');
    if (qr) handleQR(qr, urlLang);
  }, [searchParams]);

  async function handleQR(payload, langOverride) {
    setShowScanner(false);
    setLoading(true);
    setError('');
    try {
      const result = await api.scan(payload);
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
              onClick={() => setLang(code)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Camera scan button — primary CTA */}
        <button
          className="btn btn-primary"
          style={{ fontSize: 18, padding: '16px 24px', gap: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowScanner(true)}
          disabled={loading}
        >
          📷 {lang === 'hi' ? 'QR कोड स्कैन करें' : lang === 'te' ? 'QR కోడ్ స్కాన్ చేయండి' : 'Scan QR Code'}
        </button>

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
