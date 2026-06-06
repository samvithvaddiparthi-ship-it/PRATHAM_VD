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

  useEffect(() => {
    const saved = sessionStorage.getItem('lang') || 'en';
    setLang(saved);
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    if (!token) router.push('/');
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
      await api.register({
        ...form,
        patient_phone: phone,
        patient_age: age,
        language: lang,
      });
      router.push('/patient/consent');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
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
        <button type="button" className="btn btn-outline" onClick={() => router.back()} style={{ fontSize: 13 }}>
          ← Go Back
        </button>
      </form>
    </div>
  );
}
