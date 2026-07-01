'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import ProgressBar from '../../../components/ProgressBar';

export default function Consent() {
  const router = useRouter();
  const [lang, setLang] = useState('en');

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
  }, []);

  async function handleConsent() {
    await api.consent();
    router.push('/patient/documents');
  }

  return (
    <div className="screen">
      <ProgressBar stepId="consent" lang={lang} />
      <div className="card" style={{ gap: 24, justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', fontSize: 48 }}>🔒</div>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('consent_title', lang)}</h2>
        <p style={{ lineHeight: 1.6, color: 'var(--text-light)' }}>{t('consent_body', lang)}</p>
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={handleConsent}>
          {t('consent_agree', lang)}
        </button>
        <button className="btn btn-outline" onClick={() => router.push('/patient/register')}>
          ← {t('go_back', lang)}
        </button>
      </div>
    </div>
  );
}
