'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import ProgressBar from '../../../components/ProgressBar';
import ListenButton from '../../../components/ListenButton';

// Final step of the patient pre-consult: a simple review-and-submit screen.
// Vitals are NOT collected here anymore — they're optional and can be added on
// the queue/done page or by a nurse. Submitting finalizes the session exactly as
// before (empty vitals → triage → report/COMPLETE → doctor queue).
export default function Vitals() {
  const router = useRouter();
  const [lang, setLang] = useState('en');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
  }, []);

  // Complete the pre-consult: send an empty vitals payload (values added later),
  // run triage, generate the report (which marks the session COMPLETE so it
  // reaches the doctor's queue), then go to the queue/token page.
  async function handleSubmit() {
    setLoading(true);
    setError('');
    const sessionId = sessionStorage.getItem('session_id');
    try {
      await api.submitVitals(sessionId, {});   // no vitals now — optional, added later
      await api.evaluate(sessionId);           // triage evaluation
      await api.generateReport(sessionId);     // also sets state = COMPLETE
      router.push('/patient/done');
    } catch (err) {
      setError(t('could_not_submit', lang) + ': ' + (err.message || 'Unknown error') + '. ' + t('try_again', lang));
      setLoading(false);
    }
  }

  async function handleGoBack() {
    // The interview is fully answered at this point, so simply navigating back to
    // it would immediately redirect forward again (it auto-pushes here once
    // "done"). Forget the last question along the actual DAG path first so the
    // questionnaire resumes there instead.
    try {
      const sessionId = sessionStorage.getItem('session_id');
      const { history } = await api.getInterviewHistory(sessionId);
      if (history.length > 0) {
        const last = history[history.length - 1];
        await api.rewindAnswer(last.question.id);
      }
    } catch (err) {
      console.error('rewind failed:', err);
    }
    router.push('/patient/interview');
  }

  if (loading) {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p>{t('generating_report', lang)}</p>
      </div>
    );
  }

  return (
    <div className="screen">
      <ProgressBar stepId="vitals" lang={lang} />
      <div className="card" style={{ gap: 16 }}>
        <div style={{ fontSize: 44, textAlign: 'center' }}>📝</div>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('confirm_submit_title', lang)}</h2>
        <p style={{ color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.6, fontSize: 'calc(15px * var(--fs, 1))' }}>
          {t('confirm_submit_body', lang)}
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ListenButton
            text={`${t('confirm_submit_title', lang)}. ${t('confirm_submit_body', lang)}`}
            lang={lang}
            label={lang === 'hi' ? 'सुनें' : lang === 'te' ? 'వినండి' : 'Listen'}
          />
        </div>

        {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}

        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
          {t('submit', lang)}
        </button>
        <button type="button" className="btn btn-outline" onClick={handleGoBack} disabled={loading}>
          ← {t('go_back', lang)}
        </button>
      </div>
    </div>
  );
}
