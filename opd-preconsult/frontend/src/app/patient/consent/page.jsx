'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import ProgressBar from '../../../components/ProgressBar';

export default function Consent() {
  const router = useRouter();
  const [lang, setLang] = useState('en');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
  }, []);

  async function handleConsent() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.consent();
      router.push('/patient/register');
    } catch (err) {
      // This call is authenticated, so it fails whenever the device is holding a
      // token that is no longer good (secret rotated, expired, session cleared).
      // Recording consent is the first authed step in the flow, so a silent throw
      // here left Agree looking dead — nothing moved and nothing was shown. Never
      // swallow it: a dead session can only be recovered by a fresh entry, so wipe
      // the stale state and send them back to scan; anything else is transient and
      // worth another tap.
      if (err.status === 401 || err.status === 440) {
        ['token', 'session_id', 'department', 'qr', 'otp_verified', 'register_form', 'welcome_back', 'register_progress']
          .forEach(k => { try { sessionStorage.removeItem(k); } catch {} });
        setToken(null);
        setError(t('err_session_expired', lang));
        setTimeout(() => router.push('/'), 2000);
        return;
      }
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <ProgressBar stepId="consent" lang={lang} />
      <div className="card" style={{ gap: 24, justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', fontSize: 48 }}>🔒</div>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('consent_title', lang)}</h2>
        <p style={{ lineHeight: 1.6, color: 'var(--text-light)' }}>{t('consent_body', lang)}</p>

        {/* AI notice — deliberately shown here and nowhere else. The patient reads
            it once, before consenting, rather than living under a banner for the
            whole flow. Wording is scoped to what AI genuinely does (STT, NMT, OCR,
            doctor summary); urgency is decided by fixed rules + a doctor.
            Styled as a continuation of the card, not an inset panel: same body
            type as consent_body above, separated only by a hairline rule (purely
            decorative, so it is exempt from the 3:1 non-text contrast floor). */}
        <section aria-labelledby="ai-notice-title" style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 20 }}>
          <h3 id="ai-notice-title" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1em', color: 'var(--primary)', marginBottom: 8 }}>
            <span aria-hidden="true">🤖</span>{t('ai_notice_title', lang)}
          </h3>
          <p style={{ lineHeight: 1.6, color: 'var(--text-light)' }}>{t('ai_notice_body', lang)}</p>
        </section>

        <div style={{ flex: 1 }} />
        {error && <p role="alert" style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
        <button className="btn btn-primary" onClick={handleConsent} disabled={busy}>
          {t('consent_agree', lang)}
        </button>
        <button className="btn btn-outline" onClick={() => router.push('/')}>
          ← {t('go_back', lang)}
        </button>
      </div>
    </div>
  );
}
