'use client';
import { useState, useEffect } from 'react';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import TriageBadge from '../../../components/TriageBadge';
import VitalsForm, { hasVitals } from '../../../components/VitalsForm';

export default function Done() {
  const [lang, setLang] = useState('en');
  const [session, setSession] = useState(null);
  const [vitals, setVitals] = useState(null);
  const [vitalsChecked, setVitalsChecked] = useState(false);
  const [open, setOpen] = useState(false); // vitals dropdown expanded?
  const [saving, setSaving] = useState(false);
  const [vErr, setVErr] = useState('');

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    const sid = sessionStorage.getItem('session_id');
    if (sid) {
      api.getSession(sid).then(setSession).catch(console.error);
      // "Skip" still inserts an all-NULL row, so check for actual values, not just
      // row-presence. Auto-open the form only when vitals are genuinely missing.
      api.getVitals(sid).then(row => {
        setVitals(row);
        setVitalsChecked(true);
      }).catch(() => setVitalsChecked(true));
    }
    sessionStorage.removeItem('register_form');
  }, []);

  // Late vitals: save, then re-run triage + regenerate the report so the values
  // reach the doctor and a dangerous reading can escalate triage. Same sequence
  // the vitals page uses; the backend won't downgrade the COMPLETE session.
  async function saveVitals(data) {
    const sid = sessionStorage.getItem('session_id');
    if (!sid) return;
    setSaving(true);
    setVErr('');
    try {
      await api.submitVitals(sid, data);
      await api.evaluate(sid);
      await api.generateReport(sid);
      const [s, v] = await Promise.all([api.getSession(sid), api.getVitals(sid)]);
      setSession(s);
      setVitals(v);
      setOpen(false);
    } catch (err) {
      setVErr(t('could_not_save_vitals', lang) + ': ' + (err.message || 'Unknown error') + '. ' + t('try_again', lang));
    } finally {
      setSaving(false);
    }
  }

  const recorded = hasVitals(vitals);

  return (
    <div className="screen">
      <div className="card" style={{ alignItems: 'center', gap: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 64 }}>✅</div>
        <h1 style={{ color: 'var(--primary)', fontSize: 24 }}>{t('done_title', lang)}</h1>
        <p style={{ color: 'var(--text-light)', lineHeight: 1.6 }}>{t('done_body', lang)}</p>

        {session?.triage_level && (
          <div style={{ marginTop: 4 }}>
            <TriageBadge level={session.triage_level} />
          </div>
        )}

        {(session?.token_label || session?.token_number) && (
          <div style={{ background: 'var(--bg)', borderRadius: 12, padding: 16, width: '100%' }}>
            <p style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('queue_number', lang)}</p>
            <p style={{ fontSize: 36, fontWeight: 700, color: 'var(--primary)' }}>{session.token_label || session.token_number}</p>
          </div>
        )}

        {/* Vitals: accordion tile (matches the Queue-Number tile) — late entry
            when missing, or update when already recorded. Only shown when the
            patient's department collects vitals. */}
        {vitalsChecked && session?.collect_vitals && (
          <div style={{ width: '100%', background: 'var(--bg)', borderRadius: 12, overflow: 'hidden', textAlign: 'left' }}>
            <button type="button" onClick={() => { setVErr(''); setOpen(o => !o); }} aria-expanded={open}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12,
                background: 'none', border: 'none', padding: 16, cursor: 'pointer' }}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>{recorded ? '✅' : '🩺'}</span>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: recorded ? 'var(--green)' : 'var(--primary)' }}>
                  {recorded ? t('vitals_recorded', lang) : t('add_vitals', lang)}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginTop: 2 }}>
                  {recorded ? t('tap_to_update', lang) : t('vitals_optional', lang)}
                </span>
              </span>
              <span style={{ color: 'var(--text-light)', fontSize: 12, transition: 'transform .15s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
            </button>
            {open && (
              <div style={{ padding: '0 16px 16px', borderTop: '1px solid #E0E0E0' }}>
                <p style={{ fontSize: 12, color: 'var(--text-light)', margin: '12px 0' }}>
                  {t('vitals_update_note', lang)}
                </p>
                <VitalsForm
                  lang={lang}
                  loading={saving}
                  error={vErr}
                  submitLabel={recorded ? t('update_vitals', lang) : t('save_vitals', lang)}
                  loadingLabel={t('saving', lang)}
                  onSubmit={saveVitals}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
