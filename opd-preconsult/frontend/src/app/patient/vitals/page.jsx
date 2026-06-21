'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import VitalsForm from '../../../components/VitalsForm';

export default function Vitals() {
  const router = useRouter();
  const [lang, setLang] = useState('en');
  const [loading, setLoading] = useState(false);
  const [requiredVitals, setRequiredVitals] = useState([]);
  const [requiredTests, setRequiredTests] = useState([]);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);   // false until we know whether to show the form
  const finalizing = useRef(false);             // one-shot guard for the auto-skip path

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);

    const sessionId = sessionStorage.getItem('session_id');
    if (!sessionId) { setReady(true); return; }

    (async () => {
      // Vitals are collected per-department. If this patient's department has the
      // toggle OFF, skip the form entirely: finalize the pre-consult and go straight
      // to the done page (no vitals shown here or there). Default to collecting on
      // any read error so we never silently drop required vitals.
      let collect = true;
      try {
        const s = await api.getSession(sessionId);
        collect = s?.collect_vitals !== false;
      } catch { /* keep default true */ }

      if (!collect) {
        if (!finalizing.current) { finalizing.current = true; finish({}); }
        return;
      }

      // Department collects vitals — load protocol-required vitals/tests, then show the form.
      try {
        const data = await api.evaluateProtocols(sessionId);
        const vitals = [];
        const tests = [];
        (data.matched_protocols || []).forEach(p => {
          if (p.required_vitals) vitals.push(...(Array.isArray(p.required_vitals) ? p.required_vitals : []));
          if (p.required_tests) tests.push(...(Array.isArray(p.required_tests) ? p.required_tests : []));
        });
        setRequiredVitals([...new Set(vitals)]);
        setRequiredTests([...new Set(tests)]);
      } catch {}
      setReady(true);
    })();
  }, []);

  // Complete the pre-consult: save whatever vitals we have (possibly none),
  // run triage, generate the report (which marks the session COMPLETE so it
  // reaches the doctor's queue), then finish. Used by both "Submit" and
  // "Skip vitals for now" — skipping just sends an empty vitals payload, so a
  // nurse can record the values later without the patient waiting here.
  async function finish(data) {
    setLoading(true);
    setError('');
    const sessionId = sessionStorage.getItem('session_id');
    try {
      await api.submitVitals(sessionId, data);
      await api.evaluate(sessionId);        // triage evaluation
      await api.generateReport(sessionId);  // also sets state = COMPLETE
      router.push('/patient/done');
    } catch (err) {
      setError(t('could_not_submit', lang) + ': ' + (err.message || 'Unknown error') + '. ' + t('try_again', lang));
      setLoading(false);
    }
  }

  // No vitals entered now — nurse records them later (or the patient adds them on
  // the queue page). Still completes the pre-consult so they aren't stuck here.
  function handleSkip() {
    finish({});
  }

  async function handleGoBack() {
    // The interview is fully answered at this point, so simply navigating back to
    // it would immediately redirect forward again (it auto-pushes to vitals once
    // "done"). Forget the last question along the actual DAG path first so the
    // questionnaire resumes there instead. We use the structural history walk (not
    // the raw, created_at-ordered answer log) — that log's order can be scrambled
    // by earlier rewind/resubmit cycles and would pick the wrong "last" question.
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

  const protocolBanner = (requiredVitals.length > 0 || requiredTests.length > 0) ? (
    <div style={{ background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 8, padding: 10, fontSize: 13 }}>
      <strong>{t('protocol_required', lang)}</strong>
      {requiredVitals.length > 0 && <div>{t('protocol_vitals', lang)} {requiredVitals.join(', ')}</div>}
      {requiredTests.length > 0 && <div>{t('protocol_tests', lang)} {requiredTests.join(', ')}</div>}
    </div>
  ) : null;

  const footer = (
    <>
      <p style={{ fontSize: 12, color: 'var(--text-light)', textAlign: 'center', margin: 0 }}>
        {t('nurse_later', lang)}
      </p>
      <button type="button" className="btn btn-outline" onClick={handleGoBack} disabled={loading} style={{ fontSize: 13 }}>
        ← {t('go_back', lang)}
      </button>
    </>
  );

  // While deciding whether to show the form (or auto-finalizing for a no-vitals
  // department), show a loader so the form never flashes.
  if (!ready) {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p>{t('generating_report', lang)}</p>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="progress-dots">
        <span className="dot done" /><span className="dot done" /><span className="dot done" /><span className="dot done" /><span className="dot active" />
      </div>
      <div className="card" style={{ gap: 12 }}>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('vitals_title', lang)}</h2>
        <VitalsForm
          lang={lang}
          loading={loading}
          error={error}
          submitLabel={t('submit', lang)}
          loadingLabel={t('generating_report', lang)}
          onSubmit={finish}
          showSkip
          onSkip={handleSkip}
          header={protocolBanner}
          footer={footer}
        />
      </div>
    </div>
  );
}
