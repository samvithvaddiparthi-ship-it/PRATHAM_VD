'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';
import ProgressBar from '../../../components/ProgressBar';
import QuestionCard from '../../../components/QuestionCard';
import TriageBadge from '../../../components/TriageBadge';

// "Question" label for the within-step counter shown on the progress bar.
const QUESTION_WORD = { en: 'Question', hi: 'प्रश्न', te: 'ప్రశ్న' };

export default function Interview() {
  const router = useRouter();
  const [lang, setLang] = useState('en');
  const [question, setQuestion] = useState(null);
  const [history, setHistory] = useState([]);   // questions already seen (past)
  const [future, setFuture] = useState([]);     // questions ahead (when navigating back)
  const [answers, setAnswers] = useState({});   // saved answers keyed by question ID
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [triageAlert, setTriageAlert] = useState(null);
  const [sessionId, setSessionId] = useState('');
  // Total questions for the "Question X/Y" counter. The questionnaire is a
  // branching DAG, so the exact number a patient answers varies by their path —
  // we use the department's active question count as an upper bound (numerator is
  // clamped so it never exceeds it). 0 = unknown → we show just "Question X".
  const [totalQ, setTotalQ] = useState(0);

  useEffect(() => {
    const l = sessionStorage.getItem('lang') || 'en';
    setLang(l);
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    const sid = sessionStorage.getItem('session_id');
    setSessionId(sid);
    if (sid) init(sid);
    loadTotal(sid);
  }, []);

  // Count the department's visible questions for the counter denominator. Excludes
  // the hidden auto-answered visit-type node and any TERMINAL nodes (not asked).
  async function loadTotal(sid) {
    try {
      let dept = sessionStorage.getItem('department');
      if (!dept && sid) { try { dept = (await api.getSession(sid))?.department; } catch {} }
      if (!dept) return;
      const nodes = await api.getQuestionnaireSchema(dept);
      const count = (nodes || []).filter(n =>
        n && n.is_active !== false && n.q_type !== 'TERMINAL' && !String(n.id).endsWith('_visit_type')
      ).length;
      setTotalQ(count);
    } catch { /* best-effort — fall back to "Question X" */ }
  }

  // Rebuild `history` and `answers` from the server's DAG-walk history
  // before loading the current question. Without this, every remount (e.g.
  // returning from the documents/vitals pages) starts with an empty in-memory
  // history, so "Go Back" can only fall through to the browser's previous
  // route instead of stepping back through previously-answered questions.
  //
  // We use /api/q/history (a structural DAG walk) rather than the raw
  // /api/q/answers log — the raw log is ordered by created_at, which gets
  // scrambled by rewind+resubmit cycles and was the source of the "random"
  // page-interchanging bug. The walk always returns questions in actual
  // path order, regardless of when each answer was (re)recorded.
  async function init(sid) {
    try {
      const { history: pastEntries } = await api.getInterviewHistory(sid);
      // q_visit_type is auto-answered behind the scenes (the patient never sees
      // that question), so keep it out of the visible Go Back history.
      const visible = pastEntries.filter(e => !e.question.id.endsWith('_visit_type'));
      setHistory(visible.map(e => e.question));
      setAnswers(Object.fromEntries(pastEntries.map(e => [e.question.id, e.answer_raw])));
    } catch (err) {
      console.error('failed to rebuild interview history:', err);
    }
    await loadNext(sid);
  }

  async function loadNext(sid) {
    setLoading(true);
    try {
      const res = await api.nextQuestion(sid || sessionId);
      if (res.done) {
        setDone(true);
      } else {
        // q_visit_type is resolved server-side and never returned here, but keep
        // the guard so it can never slip into the visible Go Back history.
        setQuestion(prev => {
          if (prev && !prev.id.endsWith('_visit_type')) setHistory(h => [...h, prev]);
          return res.question;
        });
        setFuture([]); // clear future when we get a fresh question from server
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAnswer(answerRaw) {
    if (!question) return;

    // Detect whether the user actually modified the answer for this question
    // (vs. just clicking Next to confirm what was already there). If they
    // changed it, the DAG branch leaving this node may now differ — so the
    // queued `future` stack (which holds the OLD branch's downstream
    // questions) is stale and must be discarded; we re-ask the server for
    // the next question along the NEW branch instead.
    const prevAnswer = answers[question.id];
    const answerChanged = prevAnswer !== undefined && prevAnswer !== answerRaw;

    // Save the answer for this question
    setAnswers(prev => ({ ...prev, [question.id]: answerRaw }));

    const usingFuture = future.length > 0 && !answerChanged;
    if (answerChanged) setFuture([]);

    // Always persist to the server — including when re-confirming an
    // already-answered question via the future stack — so the server's
    // permanent record stays in sync with what the user is shown. This
    // matters because going back rewinds (deletes) the stored answer for
    // the current question, and it must be re-saved if the user proceeds.
    setLoading(true);
    try {
      const result = await api.submitAnswer({
        question_id: question.id,
        answer_raw: answerRaw,
        answer_structured: { value: answerRaw },
        input_mode: 'text',
      });

      if (result.triage_flag === 'RED') {
        setTriageAlert('RED');
      }

      if (usingFuture) {
        setHistory(h => [...h, question]);
        const next = future[0];
        setFuture(f => f.slice(1));
        setQuestion(next);
        setLoading(false);
      } else {
        await loadNext(sessionId);
      }
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  }

  async function handleGoBack() {
    if (history.length > 0) {
      const prev = history[history.length - 1];
      setLoading(true);
      try {
        // Forget the server-side answer for the question we're returning to,
        // so the DAG resume walk stops there instead of skipping past it.
        // This MUST be awaited before we update local state/navigate — firing
        // it without waiting let rapid repeated "Go Back" clicks race with
        // re-submission, leaving the server's record out of sync with what
        // was shown on screen (the "random page interchange" symptom).
        await api.rewindAnswer(prev.id);
      } catch (err) {
        console.error('rewind failed:', err);
      }
      // Push current question to future so Next can navigate forward through it
      setFuture(f => [question, ...f]);
      setHistory(h => h.slice(0, -1));
      setQuestion(prev);
      setDone(false);
      setLoading(false);
    } else {
      // No earlier real question — the page before the interview is Documents
      // (flow: consent → documents → interview). Navigate there explicitly.
      router.push('/patient/documents');
    }
  }

  if (triageAlert === 'RED') {
    return (
      <div className="screen" style={{ background: 'var(--red)', justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
        <div style={{ color: '#fff', fontSize: 64 }}>🏥</div>
        <h1 style={{ color: '#fff', fontSize: 28, margin: '16px 0' }}>{t('emergency', lang)}</h1>
        <TriageBadge level="RED" lang={lang} />
        <button
          className="btn"
          style={{ background: '#fff', color: 'var(--red)', marginTop: 32, maxWidth: 280 }}
          onClick={() => { setTriageAlert(null); loadNext(sessionId); }}
        >
          {t('continue_questions', lang)}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="screen" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <p>{t('loading', lang)}</p>
      </div>
    );
  }

  if (done) {
    router.push('/patient/vitals');
    return null;
  }

  return (
    <div className="screen">
      <ProgressBar stepId="interview" lang={lang} note={
        totalQ > 0
          ? `${QUESTION_WORD[lang] || QUESTION_WORD.en} ${Math.min(history.length + 1, totalQ)}/${totalQ}`
          : `${QUESTION_WORD[lang] || QUESTION_WORD.en} ${history.length + 1}`
      } />
      <h3 style={{ textAlign: 'center', color: 'var(--text-light)', marginBottom: 8 }}>{t('interview_title', lang)}</h3>
      {question && <QuestionCard question={question} lang={lang} onAnswer={handleAnswer} initialValue={answers[question.id] || ''} />}
      <button className="btn btn-outline" onClick={handleGoBack} style={{ marginTop: 12 }}>
        ← {t('go_back', lang)}
      </button>
    </div>
  );
}
