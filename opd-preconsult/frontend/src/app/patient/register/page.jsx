'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t, tf } from '../../../lib/i18n';
import { normalizeIndianPhone } from '../../../lib/phone';
import ProgressBar from '../../../components/ProgressBar';
import ListenButton from '../../../components/ListenButton';

// Friendly per-department icon (matched by a substring of the code); admin-set
// icon from the DB wins, else a code guess, else the generic hospital symbol.
const DEPT_ICONS = [
  [/CARD/, '🫀'], [/GEN|MED/, '🩺'], [/ORTH/, '🦴'], [/ENT/, '👂'],
  [/EYE|OPH/, '👁️'], [/DERM|SKIN/, '🧴'], [/PED|CHILD/, '🧒'], [/GYN|OBS/, '🤰'],
  [/NEUR/, '🧠'], [/DENT/, '🦷'], [/PSY/, '🧑‍⚕️'], [/PULM|CHEST|RESP/, '🫁'],
];
function deptIcon(dept) {
  if (dept && dept.icon && String(dept.icon).trim()) return String(dept.icon).trim();
  const c = String(dept?.code || '').toUpperCase();
  for (const [re, icon] of DEPT_ICONS) if (re.test(c)) return icon;
  return '🏥';
}

// Patient entry flow:
//   1. phone       — enter mobile number, request an SMS OTP
//   2. otp         — enter the 6-digit code to verify the number is reachable
//   3. identify    — pick WHICH person is visiting (one number may serve a whole
//                    family), or add a new person (name/age/gender)
//   4. department  — choose the department + an optional preferred doctor, then
//                    POST /register (department is now set here, not at scan)
export default function Register() {
  const router = useRouter();
  const [lang, setLang] = useState('en');

  const [phase, setPhase] = useState('phone');     // phone | otp | identify | department
  const [phone, setPhone] = useState('');          // 10-digit national, while typing
  const [code, setCode] = useState('');
  const [people, setPeople] = useState([]);        // prior people on this number
  const [selected, setSelected] = useState(null);  // index into people, or 'new'
  const [verifiedPhone, setVerifiedPhone] = useState(''); // the number already OTP-verified
  const [form, setForm] = useState({ patient_name: '', patient_age: '', patient_gender: '' });
  const [identity, setIdentity] = useState(null);  // chosen identity, carried into the department step

  // Department picker (step 4) — chosen after details now.
  const [departments, setDepartments] = useState([]);
  const [deptLoading, setDeptLoading] = useState(false);
  const [deptQuery, setDeptQuery] = useState('');
  const [lastTokens, setLastTokens] = useState({});
  const [chosenDept, setChosenDept] = useState('');
  // Preferred-doctor picker (optional): active doctors in the CHOSEN department.
  const [doctors, setDoctors] = useState([]);
  const [prefDoctorId, setPrefDoctorId] = useState('');   // '' = no preference / first available
  const [docQuery, setDocQuery] = useState('');

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

  // ── Step 3 → 4: validate the chosen identity, then go to the department step ──
  async function goToDepartment(e) {
    if (e) e.preventDefault();
    setError('');

    let id;
    if (selected === 'new') {
      if (!String(form.patient_name).trim()) { setError(t('err_name', lang)); return; }
      if (!form.patient_gender) { setError(t('err_gender', lang)); return; }
      if (String(form.patient_age).trim() === '') { setError(t('err_age_required', lang)); return; }
      const age = parseInt(form.patient_age);
      if (Number.isNaN(age) || age < 0 || age > 120) { setError(t('err_age_range', lang)); return; }
      id = { patient_name: form.patient_name.trim(), patient_age: age, patient_gender: form.patient_gender };
    } else if (selected !== null && people[selected]) {
      const p = people[selected];
      id = { patient_name: p.name, patient_age: p.age, patient_gender: p.gender };
    } else {
      setError(t('who_title', lang));   // nudge: pick someone
      return;
    }

    // Block a duplicate entry for the same person while their prior visit is still
    // open — surfaced HERE, the moment the name is chosen, not after the department
    // step. (The /register call is still the authoritative backstop.)
    setLoading(true);
    try {
      const { active } = await api.checkActive(id.patient_name).catch(() => ({ active: false }));
      if (active) { setError(t('already_consulting', lang)); return; }
    } finally {
      setLoading(false);
    }

    setIdentity(id);
    setPhase('department');
    loadDepartments();
  }

  async function loadDepartments() {
    setDeptLoading(true);
    try {
      const [depts, last] = await Promise.all([
        api.getDepartments(),
        api.queueLast().catch(() => ({ departments: [] })),
      ]);
      setDepartments((depts || []).filter(d => d && d.code && d.is_active !== false));
      const map = {};
      (last?.departments || []).forEach(x => { map[x.department] = { label: x.token_label, count: x.last_token || 0 }; });
      setLastTokens(map);
    } catch {
      setError(t('try_again', lang));
    } finally {
      setDeptLoading(false);
    }
  }

  // Choosing a department loads that department's doctors for the preference picker
  // and resets any previous preference.
  function selectDept(code) {
    setChosenDept(code);
    setPrefDoctorId('');
    setDocQuery('');
    setError('');
    api.listDoctors(code)
      .then(list => setDoctors((list || []).filter(d => d && d.is_active !== false)))
      .catch(() => setDoctors([]));
  }

  // ── Step 4: final submit — register identity + department + preferred doctor ──
  async function submitFinal() {
    if (!chosenDept) { setError(t('choose_department', lang)); return; }
    if (!identity) { setPhase('identify'); return; }
    setLoading(true);
    setError('');
    try {
      const { e164 } = normalizeIndianPhone(phone);
      const prefName = prefDoctorId ? (doctors.find(d => d.id === prefDoctorId)?.name || null) : null;
      await api.register({
        ...identity, patient_phone: e164, language: lang, department: chosenDept,
        preferred_doctor_id: prefDoctorId || null, preferred_doctor_name: prefName,
      });
      try { sessionStorage.setItem('department', chosenDept); } catch {}
      router.push('/patient/consent');
    } catch (err) {
      if (/session not found|phone not verified|session_finished/i.test(err.message || '')) {
        setError(t('err_session_expired', lang));
        setTimeout(() => { sessionStorage.removeItem('token'); router.push('/'); }, 1500);
        return;
      }
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

  // ─────────────────────────── Step 1: phone ───────────────────────────
  if (phase === 'phone') {
    return (
      <div className="screen">
        <ProgressBar stepId="register" lang={lang} />
        <form className="card" style={{ gap: 16 }} onSubmit={sendOtp} noValidate>
          <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('otp_phone_title', lang)}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.5 }}>{t('otp_phone_sub', lang)}</p>

          <div>
            <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('phone', lang)} *</label>
            {/* 10 digits = a standard Indian mobile number; normalizeIndianPhone validates. */}
            <input className="input" type="tel" inputMode="numeric" maxLength={10}
              placeholder="9876543210"
              value={phone}
              onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))} />
          </div>

          {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit" disabled={loading}>
            {loading ? t('sending', lang) : t('send_code', lang)}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => router.push('/')}>
            ← {t('go_back', lang)}
          </button>
        </form>
      </div>
    );
  }

  // ─────────────────────────── Step 2: otp ───────────────────────────
  if (phase === 'otp') {
    const { e164 } = normalizeIndianPhone(phone);

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

    const alreadyVerified = verifiedPhone && verifiedPhone === phone;

    return (
      <div className="screen">
        <ProgressBar stepId="register" lang={lang} />
        <form className="card" style={{ gap: 16 }} onSubmit={alreadyVerified ? (e) => { e.preventDefault(); setPhase('identify'); } : verifyOtp} noValidate>
          <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('otp_enter_title', lang)}</h2>
          <p style={{ fontSize: 13, color: 'var(--text-light)', textAlign: 'center', lineHeight: 1.5 }}>
            {tf('otp_sent_to', lang, { phone: e164 })}
          </p>

          {alreadyVerified ? (
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

  // ─────────────────────────── Step 4: department + preferred doctor ───────────────────────────
  if (phase === 'department') {
    const q = deptQuery.trim().toLowerCase();
    const visibleDepts = departments
      .filter(d => !q || String(d.name || '').toLowerCase().includes(q) || String(d.code || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const ca = lastTokens[a.code]?.count || 0;
        const cb = lastTokens[b.code]?.count || 0;
        if (cb !== ca) return cb - ca;
        return String(a.name || a.code).localeCompare(String(b.name || b.code));
      });

    return (
      <div className="screen">
        <ProgressBar stepId="register" lang={lang} />
        <div className="card" style={{ gap: 14 }}>
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 34 }}>🏥</div>
            <h2 style={{ fontSize: 20, color: 'var(--primary)' }}>{t('choose_department', lang)}</h2>
            <p style={{ color: 'var(--text-light)', fontSize: 13 }}>{t('choose_department_sub', lang)}</p>
            <ListenButton text={`${t('choose_department', lang)}. ${t('choose_department_sub', lang)}`} lang={lang} label={t('listen', lang)} />
          </div>

          <input className="input" type="text" inputMode="search" placeholder={t('search_department', lang)}
            value={deptQuery} onChange={e => setDeptQuery(e.target.value)} />

          {deptLoading ? (
            <p style={{ textAlign: 'center', color: 'var(--text-light)' }}>{t('loading', lang)}</p>
          ) : visibleDepts.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-light)' }}>{t('no_departments', lang)}</p>
          ) : (
            <div style={{ maxHeight: '34vh', overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12 }}>
                {visibleDepts.map(d => {
                  const active = chosenDept === d.code;
                  return (
                    <button key={d.code} type="button" onClick={() => selectDept(d.code)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '16px 10px',
                        borderRadius: 12, cursor: 'pointer', textAlign: 'center', minHeight: 116, justifyContent: 'center',
                        border: active ? '3px solid var(--primary)' : '2px solid #E2E6EA',
                        background: active ? '#EAF2F8' : '#fff', color: 'var(--primary)',
                      }}>
                      <span style={{ fontSize: 32, lineHeight: 1 }} aria-hidden="true">{deptIcon(d)}</span>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{d.name || d.code}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-light)' }}>
                        {t('last_token', lang)}: {lastTokens[d.code]?.label || t('no_token_yet', lang)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Preferred doctor for the chosen department (optional) */}
          {chosenDept && doctors.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid #EEE', paddingTop: 12 }}>
              <div>
                <label style={{ fontSize: 14, color: 'var(--text-light)' }}>{t('preferred_doctor', lang)}</label>
                <p style={{ fontSize: 11.5, color: 'var(--text-light)', marginTop: 2, lineHeight: 1.4 }}>{t('preferred_doctor_hint', lang)}</p>
              </div>
              {doctors.length > 5 && (
                <input className="input" value={docQuery}
                  onChange={e => setDocQuery(e.target.value)} placeholder={t('search_doctor', lang)} />
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                <button type="button" onClick={() => setPrefDoctorId('')}
                  style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                    border: !prefDoctorId ? '2px solid var(--primary)' : '1px solid #E2E6EA',
                    background: !prefDoctorId ? 'rgba(0,0,0,0.02)' : '#fff',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{t('no_preference', lang)}</span>
                  <span style={{ fontSize: 16, color: !prefDoctorId ? 'var(--primary)' : '#C7CDD2' }}>{!prefDoctorId ? '◉' : '◯'}</span>
                </button>
                {doctors
                  .filter(d => !docQuery.trim() || String(d.name || '').toLowerCase().includes(docQuery.trim().toLowerCase()))
                  .map(d => {
                    const active = prefDoctorId === d.id;
                    return (
                      <button key={d.id} type="button" onClick={() => setPrefDoctorId(d.id)}
                        style={{ textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                          border: active ? '2px solid var(--primary)' : '1px solid #E2E6EA',
                          background: active ? 'rgba(0,0,0,0.02)' : '#fff',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700, fontSize: 14, overflowWrap: 'anywhere' }}>👨‍⚕️ {d.name}</span>
                          {d.registration_no && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-light)' }}>{d.registration_no}</span>}
                        </span>
                        <span style={{ fontSize: 16, color: active ? 'var(--primary)' : '#C7CDD2' }}>{active ? '◉' : '◯'}</span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}

          {error && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>{error}</p>}
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={submitFinal} disabled={loading || !chosenDept}>
            {loading ? '...' : t('submit', lang)}
          </button>
          {/* Back button at the BOTTOM */}
          <button type="button" className="btn btn-outline" onClick={() => { setPhase('identify'); setError(''); }}>
            ← {t('go_back', lang)}
          </button>
        </div>
      </div>
    );
  }

  // ─────────────────────────── Step 3: identify ───────────────────────────
  const hasHistory = people.length > 0;
  const showNewFields = selected === 'new';
  return (
    <div className="screen">
      <ProgressBar stepId="register" lang={lang} />
      <form className="card" style={{ gap: 16 }} onSubmit={goToDepartment} noValidate>
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
        <button type="button" className="btn btn-outline"
          onClick={() => { setPhase('otp'); setError(''); }}>
          ← {t('go_back', lang)}
        </button>
      </form>
    </div>
  );
}
