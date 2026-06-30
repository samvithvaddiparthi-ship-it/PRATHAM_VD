'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t, tf } from '../../../lib/i18n';
import { normalizeIndianPhone } from '../../../lib/phone';

// Patient entry is now a three-step flow:
//   1. phone     — enter mobile number, request an SMS OTP
//   2. otp       — enter the 6-digit code to verify the number is reachable
//   3. identify  — pick WHICH person is visiting (one number may serve a whole
//                  family), or add a new person (name/age/gender). Only after a
//                  person is chosen do we POST /register.
export default function Register() {
  const router = useRouter();
  const [lang, setLang] = useState('en');

  const [phase, setPhase] = useState('phone');     // phone | otp | identify
  const [phone, setPhone] = useState('');          // 10-digit national, while typing
  const [code, setCode] = useState('');
  const [people, setPeople] = useState([]);        // prior people on this number
  const [selected, setSelected] = useState(null);  // index into people, or 'new'
  const [verifiedPhone, setVerifiedPhone] = useState(''); // the number already OTP-verified
  const [form, setForm] = useState({ patient_name: '', patient_age: '', patient_gender: '' });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [devCode, setDevCode] = useState('');      // shown only in dry-run/dev mode
  const [resendIn, setResendIn] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const saved = sessionStorage.getItem('lang') || 'en';
    setLang(saved);
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    if (!token) { router.push('/'); return; }

    // Restore the identify step after a Go-Back from consent (within this same
    // session) so the patient doesn't have to redo the OTP. Tied to session_id so
    // a fresh QR scan never inherits a previous patient's verified state.
    const sid = sessionStorage.getItem('session_id');
    const savedV = sessionStorage.getItem('otp_verified');
    if (savedV && sid) {
      try {
        const v = JSON.parse(savedV);
        if (v.session_id === sid && v.phone) {
          setPhone(v.phone);
          setVerifiedPhone(v.phone);
          setPeople(v.people || []);
          setSelected((v.people && v.people.length) ? null : 'new');
          setPhase('identify');
        }
      } catch { /* ignore */ }
    }
  }, []);

  // Resend cooldown countdown (matches the backend's 60s per-phone gate).
  useEffect(() => {
    if (resendIn <= 0) return;
    timerRef.current = setTimeout(() => setResendIn(s => s - 1), 1000);
    return () => clearTimeout(timerRef.current);
  }, [resendIn]);

  // ── Step 1 → 2: request the OTP ──
  async function sendOtp(e) {
    if (e) e.preventDefault();
    setError('');
    const { valid } = normalizeIndianPhone(phone);
    if (!valid) { setError(t('err_phone', lang)); return; }
    setLoading(true);
    try {
      const res = await api.requestOtp(phone);
      setDevCode(res && res.dev_mode ? res.dev_code : '');
      setCode('');
      setResendIn(60);
      setPhase('otp');
    } catch (err) {
      // Any stale-credential failure (expired/invalid/missing token, or a session
      // that no longer exists) → there's nothing the patient can do here; send
      // them back to re-scan instead of dead-ending on a cryptic error.
      if (/session expired|invalid token|no token|not verified|session not found/i.test(err.message || '')) {
        sessionStorage.removeItem('token');
        sessionStorage.removeItem('otp_verified');
        setError(t('err_session_expired', lang));
        setTimeout(() => router.push('/'), 1500);
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Step 2 → 3: verify the OTP ──
  async function verifyOtp(e) {
    if (e) e.preventDefault();
    setError('');
    if (!/^\d{4,8}$/.test(code.trim())) { setError(t('err_otp_required', lang)); return; }
    setLoading(true);
    try {
      const res = await api.verifyOtp(phone, code.trim());
      const ppl = (res && res.people) || [];
      setPeople(ppl);
      setVerifiedPhone(phone);                  // remember this number is verified
      setSelected(ppl.length ? null : 'new');   // no history → straight to new-person form
      sessionStorage.setItem('otp_verified', JSON.stringify({
        session_id: sessionStorage.getItem('session_id'),
        phone, people: ppl,
      }));
      setPhase('identify');
    } catch (err) {
      // Any stale-credential failure (expired/invalid/missing token, or a session
      // that no longer exists) → there's nothing the patient can do here; send
      // them back to re-scan instead of dead-ending on a cryptic error.
      if (/session expired|invalid token|no token|not verified|session not found/i.test(err.message || '')) {
        sessionStorage.removeItem('token');
        sessionStorage.removeItem('otp_verified');
        setError(t('err_session_expired', lang));
        setTimeout(() => router.push('/'), 1500);
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Step 3: register the chosen identity ──
  async function submitIdentity(e) {
    if (e) e.preventDefault();
    setError('');

    let identity;
    if (selected === 'new') {
      if (!String(form.patient_name).trim()) { setError(t('err_name', lang)); return; }
      if (!form.patient_gender) { setError(t('err_gender', lang)); return; }
      if (String(form.patient_age).trim() === '') { setError(t('err_age_required', lang)); return; }
      const age = parseInt(form.patient_age);
      if (Number.isNaN(age) || age < 0 || age > 120) { setError(t('err_age_range', lang)); return; }
      identity = { patient_name: form.patient_name.trim(), patient_age: age, patient_gender: form.patient_gender };
    } else if (selected !== null && people[selected]) {
      const p = people[selected];
      identity = { patient_name: p.name, patient_age: p.age, patient_gender: p.gender };
    } else {
      setError(t('who_title', lang));   // nudge: pick someone
      return;
    }

    setLoading(true);
    try {
      const { e164 } = normalizeIndianPhone(phone);
      await api.register({ ...identity, patient_phone: e164, language: lang });
      router.push('/patient/consent');
    } catch (err) {
      if (/session not found|phone not verified|session_finished/i.test(err.message || '')) {
        setError(t('err_session_expired', lang));
        setTimeout(() => { sessionStorage.removeItem('token'); router.push('/'); }, 1500);
        return;
      }
      // This person already has an open visit that isn't finished yet — stay on
      // the chooser and tell them to wait (or pick a different person).
      if (/already_active/i.test(err.message || '')) {
        setError(t('already_consulting', lang));
        return;
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function fmtVisit(ts) {
    try {
      return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { return ts; }
  }

  const dots = (n) => (
    <div className="progress-dots">
      {[0, 1, 2, 3, 4].map(i => <span key={i} className={`dot ${i === 0 ? 'active' : ''}`} />)}
    </div>
  );

  // ─────────────────────────── Step 1: phone ───────────────────────────
  if (phase === 'phone') {
    return (
      <div className="screen">
        {dots()}
        <form className="card" style={{ gap: 16 }} onSubmit={sendOtp} noValidate>
          <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('otp_phone_title', lang)}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.5 }}>{t('otp_phone_sub', lang)}</p>

          <div>
            <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('phone', lang)} *</label>
            {/* TESTING-ONLY HARD CAP — remove before production (see note). */}
            <input className="input" type="tel" inputMode="numeric" maxLength={10}
              placeholder="9876543210"
              value={phone}
              onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
            <p style={{ fontSize: 11, color: '#B7791F', background: '#FFF8E1', border: '1px dashed #F0C36D', borderRadius: 6, padding: '4px 8px', marginTop: 4 }}>
              ⚠️ Testing: phone is hard-capped to 10 digits. Remove this cap before production.
            </p>
          </div>

          {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? t('sending', lang) : t('send_code', lang)}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => router.push('/')} style={{ fontSize: 13 }}>
            ← {t('go_back', lang)}
          </button>
        </form>
      </div>
    );
  }

  // ─────────────────────────── Step 2: otp ───────────────────────────
  if (phase === 'otp') {
    const { e164 } = normalizeIndianPhone(phone);

    // Switch to a fresh number: forget the old one entirely (its OTP, verified
    // state, and any prior-people we'd loaded for it), so the next number starts
    // clean and the next OTP is the one that counts.
    const changeNumber = () => {
      setPhase('phone');
      setCode('');
      setDevCode('');
      setVerifiedPhone('');
      setPeople([]);
      setSelected(null);
      setError('');
      sessionStorage.removeItem('otp_verified');
    };

    // This number is already verified (e.g. the patient came back from the next
    // step). Don't ask for the code again — just confirm it's verified and let
    // them continue or change it.
    const alreadyVerified = verifiedPhone && verifiedPhone === phone;

    return (
      <div className="screen">
        {dots()}
        <form className="card" style={{ gap: 16 }} onSubmit={alreadyVerified ? (e) => { e.preventDefault(); setPhase('identify'); } : verifyOtp} noValidate>
          <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('otp_enter_title', lang)}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.5 }}>
            {tf('otp_sent_to', lang, { phone: e164 })}
          </p>

          {alreadyVerified ? (
            // ── Verified confirmation (no code entry, no error noise) ──
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: '#E8F6EE', border: '1px solid #9AD3B2', borderRadius: 12, padding: '18px 14px' }}>
              <div style={{ fontSize: 32 }}>✅</div>
              <p style={{ fontSize: 15, fontWeight: 700, color: '#1F6F43', textAlign: 'center' }}>{t('number_verified', lang)}</p>
            </div>
          ) : (
            <>
              {devCode && (
                <p style={{ fontSize: 12, color: '#1F6F43', background: '#E8F6EE', border: '1px dashed #9AD3B2', borderRadius: 6, padding: '6px 10px', textAlign: 'center' }}>
                  {tf('otp_dev_note', lang, { code: devCode })}
                </p>
              )}

              <div>
                <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('otp_code_label', lang)} *</label>
                <input className="input" type="tel" inputMode="numeric" maxLength={6} autoFocus
                  placeholder="------"
                  style={{ letterSpacing: 8, textAlign: 'center', fontSize: 22, fontWeight: 700 }}
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </div>

              {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
            </>
          )}

          {alreadyVerified ? (
            // Number is locked once verified. Changing it means a fresh form
            // (new session) — not looping back into this same rate-limited one.
            <p style={{ fontSize: 12.5, color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.6 }}>
              {t('change_number_locked', lang)}{' '}
              <button type="button" onClick={() => { sessionStorage.removeItem('otp_verified'); router.push('/'); }}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0, fontWeight: 600, textDecoration: 'underline' }}>
                {t('start_new_form', lang)}
              </button>
            </p>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
              <button type="button" onClick={changeNumber}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}>
                {t('change_number', lang)}
              </button>
              <button type="button" disabled={resendIn > 0 || loading} onClick={() => sendOtp()}
                style={{ background: 'none', border: 'none', color: resendIn > 0 ? 'var(--text-light)' : 'var(--primary)', cursor: resendIn > 0 ? 'default' : 'pointer', padding: 0 }}>
                {resendIn > 0 ? tf('resend_in', lang, { n: resendIn }) : t('resend_code', lang)}
              </button>
            </div>
          )}

          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {alreadyVerified ? t('next', lang) : (loading ? t('verifying', lang) : t('verify', lang))}
          </button>
        </form>
      </div>
    );
  }

  // ─────────────────────────── Step 3: identify ───────────────────────────
  const hasHistory = people.length > 0;
  const showNewFields = selected === 'new';
  return (
    <div className="screen">
      {dots()}
      <form className="card" style={{ gap: 16 }} onSubmit={submitIdentity} noValidate>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>
          {hasHistory ? t('who_title', lang) : t('new_person_title', lang)}
        </h2>
        {hasHistory && (
          <p style={{ fontSize: 13, color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.5 }}>{t('who_sub', lang)}</p>
        )}

        {hasHistory && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {people.map((p, i) => {
              const active = selected === i;
              return (
                <button key={i} type="button" onClick={() => { setSelected(i); setError(''); }}
                  style={{
                    textAlign: 'left', padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
                    border: active ? '2px solid var(--primary)' : '1px solid #E2E6EA',
                    background: active ? 'rgba(0,0,0,0.02)' : '#fff',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                  }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 700, fontSize: 15, color: 'var(--text)', overflowWrap: 'anywhere' }}>{p.name}</span>
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--text-light)', marginTop: 2 }}>
                      {[p.age != null && p.age !== '' ? `${p.age}` : null, p.gender || null].filter(Boolean).join(' · ')}
                      {p.last_visit ? `  ·  ${t('last_visit_label', lang)}: ${fmtVisit(p.last_visit)}` : ''}
                    </span>
                  </span>
                  <span style={{ fontSize: 18, color: active ? 'var(--primary)' : '#C7CDD2' }}>{active ? '◉' : '◯'}</span>
                </button>
              );
            })}
            {/* "Someone else" — a new person sharing this number. */}
            <button type="button" onClick={() => { setSelected('new'); setError(''); }}
              style={{
                textAlign: 'left', padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
                border: showNewFields ? '2px solid var(--primary)' : '1px dashed #C7CDD2',
                background: showNewFields ? 'rgba(0,0,0,0.02)' : '#fff',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>＋ {t('someone_else', lang)}</span>
              <span style={{ fontSize: 18, color: showNewFields ? 'var(--primary)' : '#C7CDD2' }}>{showNewFields ? '◉' : '◯'}</span>
            </button>
          </div>
        )}

        {/* New-person details — revealed when "someone else" is chosen, or shown
            directly when this number has no prior patients. */}
        {showNewFields && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: hasHistory ? 4 : 0 }}>
            <div>
              <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('name', lang)} *</label>
              <input className="input" maxLength={40} autoFocus={hasHistory}
                value={form.patient_name}
                onChange={e => setForm({ ...form, patient_name: e.target.value.slice(0, 40) })} />
            </div>
            <div>
              <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('age', lang)} *</label>
              <input className="input" type="number" value={form.patient_age}
                onChange={e => setForm({ ...form, patient_age: e.target.value })} />
            </div>
            <div>
              <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('gender', lang)} *</label>
              {/* Icon buttons instead of a dropdown — clearer for low-literacy/elderly. */}
              <div style={{ display: 'flex', gap: 8 }}>
                {[['M', '👨', t('male', lang)], ['F', '👩', t('female', lang)], ['O', '🧑', t('other', lang)]].map(([val, icon, lbl]) => (
                  <button
                    type="button"
                    key={val}
                    className={`btn ${form.patient_gender === val ? 'btn-primary' : 'btn-outline'}`}
                    style={{ flex: 1, flexDirection: 'column', gap: 2, padding: '8px 4px' }}
                    onClick={() => setForm({ ...form, patient_gender: val })}
                  >
                    <span aria-hidden="true" style={{ fontSize: 22 }}>{icon}</span>
                    <span style={{ fontSize: 'calc(13px * var(--fs, 1))' }}>{lbl}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
        <div style={{ flex: 1 }} />
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? '...' : t('next', lang)}
        </button>
        <button type="button" className="btn btn-outline" style={{ fontSize: 13 }}
          onClick={() => { setPhase('otp'); setError(''); }}>
          ← {t('go_back', lang)}
        </button>
      </form>
    </div>
  );
}
