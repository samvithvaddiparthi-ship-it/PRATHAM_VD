'use client';
import { useState, useEffect } from 'react';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import TriageBadge from '../../../components/TriageBadge';

export default function Done() {
  const [lang, setLang] = useState('en');
  const [session, setSession] = useState(null);

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    const sid = sessionStorage.getItem('session_id');
    if (sid) api.getSession(sid).then(setSession).catch(console.error);
    sessionStorage.removeItem('register_form');
  }, []);

  return (
    <div className="screen">
      <div className="card" style={{ justifyContent: 'center', alignItems: 'center', gap: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 64 }}>✅</div>
        <h1 style={{ color: 'var(--primary)', fontSize: 24 }}>{t('done_title', lang)}</h1>
        <p style={{ color: 'var(--text-light)', lineHeight: 1.6 }}>{t('done_body', lang)}</p>

        {session?.triage_level && (
          <div style={{ marginTop: 8 }}>
            <TriageBadge level={session.triage_level} />
          </div>
        )}

        {session?.queue_slot && (
          <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 16, width: '100%' }}>
            <p style={{ fontSize: 14, color: 'var(--text-light)' }}>Queue Number</p>
            <p style={{ fontSize: 36, fontWeight: 700, color: 'var(--primary)' }}>{session.queue_slot}</p>
          </div>
        )}
      </div>
    </div>
  );
}
