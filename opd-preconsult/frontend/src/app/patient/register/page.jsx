'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t } from '../../../lib/i18n';

export default function Register() {
  const router = useRouter();
  const [lang, setLang] = useState('en');
  const [form, setForm] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('register_form');
      if (saved) return JSON.parse(saved);
    }
    return { patient_name: '', patient_phone: '', patient_age: '', patient_gender: '' };
  });
  const [loading, setLoading] = useState(false);
  // Login history shown to returning patients after they submit credentials.
  const [welcomeBack, setWelcomeBack] = useState(null); // { count, logins: [{created_at, department}] }

  useEffect(() => {
    const saved = sessionStorage.getItem('lang') || 'en';
    setLang(saved);
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    if (!token) { router.push('/'); return; }

    // Re-show the welcome-back card if we're returning to this page within the
    // SAME session (e.g. Go Back from the consent page). We tie the saved card
    // to the session_id so a different patient scanning a fresh QR never
    // inherits a stale card from a previous patient.
    const sid = sessionStorage.getItem('session_id');
    const savedWb = sessionStorage.getItem('welcome_back');
    if (savedWb && sid) {
      try {
        const parsed = JSON.parse(savedWb);
        if (parsed.session_id === sid) {
          setWelcomeBack({ count: parsed.count, logins: parsed.logins });
        } else {
          sessionStorage.removeItem('welcome_back');
        }
      } catch {
        sessionStorage.removeItem('welcome_back');
      }
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem('register_form', JSON.stringify(form));
  }, [form]);

  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Phone validation — must be 10 digits (Indian mobile number)
    const phone = form.patient_phone.replace(/\s+/g, '');
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setError('Enter a valid 10-digit mobile number starting with 6, 7, 8, or 9.');
      return;
    }

    // Gender required
    if (!form.patient_gender) {
      setError('Please select a gender.');
      return;
    }

    // Age cap
    const age = form.patient_age ? parseInt(form.patient_age) : null;
    if (age !== null && (age < 0 || age > 120)) {
      setError('Age must be between 0 and 120.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.register({
        ...form,
        patient_phone: phone,
        patient_age: age,
        language: lang,
      });
      // Show a welcome card for everyone after they submit credentials:
      // "Welcome back" (with visit history) for returning patients, or a
      // first-time greeting otherwise. Persist it (scoped to this session) so
      // navigating back from consent re-shows it, and record whether the
      // patient is returning so the interview can auto-resolve first/follow-up
      // without ever showing the "first visit or follow-up?" question.
      const wb = { count: (res && res.previous_login_count) || 0, logins: (res && res.previous_logins) || [] };
      setWelcomeBack(wb);
      sessionStorage.setItem('welcome_back', JSON.stringify({ session_id: sessionStorage.getItem('session_id'), ...wb }));
      setLoading(false);
      return;
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  function formatVisit(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch {
      return ts;
    }
  }

  if (welcomeBack) {
    const isReturning = welcomeBack.count > 0;
    const last = welcomeBack.logins[0];
    return (
      <div className="screen" style={{ justifyContent: 'center' }}>
        <div className="card" style={{ gap: 18, textAlign: 'center' }}>
          <div style={{ fontSize: 48 }}>{isReturning ? '👋' : '🎉'}</div>
          <h2 style={{ color: 'var(--primary)' }}>
            {isReturning ? `Welcome back, ${form.patient_name}!` : `Welcome, ${form.patient_name}!`}
          </h2>
          <p style={{ color: 'var(--text-light)', lineHeight: 1.5 }}>
            {isReturning ? (
              <>
                We found <strong>{welcomeBack.count}</strong> previous {welcomeBack.count === 1 ? 'visit' : 'visits'} linked to this mobile number.
                {last && <> Your last visit was on <strong>{formatVisit(last.created_at)}</strong>.</>}
              </>
            ) : (
              <>This looks like your first visit with us — or a new mobile number. We'll guide you through a few quick steps to prepare your details for the doctor. <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>If you've visited before, please double-check your mobile number.</span></>
            )}
          </p>

          {isReturning && welcomeBack.logins.length > 0 && (
            <div style={{ background: '#F8F9FA', borderRadius: 12, padding: 14, textAlign: 'left' }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary)', marginBottom: 8 }}>Recent visits</p>
              {welcomeBack.logins.map((v, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderTop: i ? '1px solid #ECECEC' : 'none' }}>
                  <span>{formatVisit(v.created_at)}</span>
                  <span style={{ color: 'var(--text-light)', textTransform: 'uppercase' }}>{v.department}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={() => router.push('/patient/consent')}>
            {t('next', lang)}
          </button>
          {/* Go Back just dismisses this card and returns to the credentials
              form (same page, local state only) — no router navigation, so it
              cannot reorder pages no matter how many times it's clicked. The
              entered form data is preserved. */}
          <button className="btn btn-outline" onClick={() => { setWelcomeBack(null); sessionStorage.removeItem('welcome_back'); }} style={{ fontSize: 13 }}>
            ← Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="progress-dots">
        <span className="dot active" /><span className="dot" /><span className="dot" /><span className="dot" /><span className="dot" />
      </div>
      <form className="card" style={{ gap: 16 }} onSubmit={handleSubmit}>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('register', lang)}</h2>

        <div>
          <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('name', lang)} *</label>
          <input className="input" required value={form.patient_name} onChange={e => setForm({ ...form, patient_name: e.target.value })} />
        </div>
        <div>
          <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('phone', lang)} *</label>
          <input className="input" type="tel" required value={form.patient_phone} onChange={e => setForm({ ...form, patient_phone: e.target.value })} />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('age', lang)}</label>
            <input className="input" type="number" min="0" max="120" value={form.patient_age} onChange={e => setForm({ ...form, patient_age: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('gender', lang)}</label>
            <select className="input" value={form.patient_gender} onChange={e => setForm({ ...form, patient_gender: e.target.value })}>
              <option value="">--</option>
              <option value="M">{t('male', lang)}</option>
              <option value="F">{t('female', lang)}</option>
              <option value="O">{t('other', lang)}</option>
            </select>
          </div>
        </div>

        {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? '...' : t('next', lang)}
        </button>
        <button type="button" className="btn btn-outline" onClick={() => router.push('/')} style={{ fontSize: 13 }}>
          ← Go Back
        </button>
      </form>
    </div>
  );
}
