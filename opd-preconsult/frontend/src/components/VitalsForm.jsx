'use client';
import { useState } from 'react';
import { t } from '../lib/i18n';

// The vital fields a session can carry (matches the session_vitals columns).
const VITAL_KEYS = ['bp_systolic', 'bp_diastolic', 'weight_kg', 'spo2_pct', 'heart_rate', 'temperature_c'];

// Hard input limits [min, max] — mirror the node-backend guard in routes/vitals.js.
// Enforced live in the field (values above max simply won't type), so impossible
// entries are impossible to enter, not just rejected on submit.
const VITAL_LIMITS = {
  bp_systolic:   [0, 999],
  bp_diastolic:  [0, 999],
  weight_kg:     [0, 999],
  spo2_pct:      [0, 100],
  heart_rate:    [0, 999],
  temperature_c: [0, 99],
};

// True if a session_vitals row actually holds any measured value. Needed because
// "Skip vitals" still inserts a row with all-NULL fields — so row-presence alone
// does NOT mean vitals were recorded.
export function hasVitals(row) {
  if (!row) return false;
  return VITAL_KEYS.some(k => row[k] !== null && row[k] !== undefined && row[k] !== '');
}

/**
 * Shared vitals entry form (BP / weight / SpO2 / HR / temp). Self-contained field
 * state; hands the parsed numeric payload to `onSubmit`. Used by the patient vitals
 * page and the queue (done) page late-entry — and reusable for a doctor-side entry.
 */
export default function VitalsForm({
  lang = 'en', loading = false, error = '',
  submitLabel, loadingLabel, onSubmit,
  showSkip = false, onSkip, header = null, footer = null,
}) {
  const [form, setForm] = useState({
    bp_systolic: '', bp_diastolic: '', weight_kg: '', spo2_pct: '', heart_rate: '', temperature_c: '',
  });
  const [limitError, setLimitError] = useState('');

  // Live input filter — allow only digits and a single decimal point, and reject
  // any keystroke that would push the number above the field's max (so you cannot
  // type an impossible value at all, like the 10-digit cap on the phone field).
  function handleChange(key, raw) {
    if (raw === '') { setForm(f => ({ ...f, [key]: '' })); return; }
    if (!/^\d*\.?\d*$/.test(raw)) return;              // digits + optional single dot only (no -, e, +)
    const [, max] = VITAL_LIMITS[key] || [0, Infinity];
    const n = parseFloat(raw);
    if (!Number.isNaN(n) && n > max) return;           // would exceed the cap → ignore keystroke
    setForm(f => ({ ...f, [key]: raw }));
  }

  const fields = [
    ['bp_systolic', t('bp_systolic', lang), 'number', '120'],
    ['bp_diastolic', t('bp_diastolic', lang), 'number', '80'],
    ['weight_kg', t('weight', lang), 'number', '70'],
    ['spo2_pct', t('spo2', lang), 'number', '98'],
    ['heart_rate', t('heart_rate', lang), 'number', '72'],
    ['temperature_c', t('temperature', lang), 'number', '36.6'],
  ];

  function handleSubmit(e) {
    e.preventDefault();
    const data = {};
    for (const [k, v] of Object.entries(form)) {
      if (v !== '' && v !== null && v !== undefined) data[k] = parseFloat(v);
    }
    // Hard-limit check before submitting — catch impossible entries locally.
    for (const [k, val] of Object.entries(data)) {
      const lim = VITAL_LIMITS[k];
      if (!lim) continue;
      if (!Number.isFinite(val) || val < lim[0] || val > lim[1]) {
        const label = (fields.find(f => f[0] === k) || [])[1] || k;
        setLimitError(`${label}: enter a value between ${lim[0]} and ${lim[1]}.`);
        return;
      }
    }
    setLimitError('');
    onSubmit(data);
  }

  return (
    <form style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={handleSubmit}>
      {header}
      {fields.map(([key, label, type, placeholder]) => (
        <div key={key}>
          <label style={{ fontSize: 13, color: 'var(--text-light)' }}>{label}</label>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            placeholder={placeholder}
            value={form[key]}
            onChange={e => handleChange(key, e.target.value)}
          />
        </div>
      ))}

      {(limitError || error) && (
        <div style={{ background: '#FADBD8', color: '#C0392B', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
          {limitError || error}
        </div>
      )}

      <button className="btn btn-primary" type="submit" disabled={loading}>
        {loading ? (loadingLabel || submitLabel || t('submit', lang)) : (submitLabel || t('submit', lang))}
      </button>

      {showSkip && (
        <button type="button" className="btn btn-secondary" onClick={onSkip} disabled={loading} style={{ fontSize: 14 }}>
          {t('skip_vitals', lang)}
        </button>
      )}

      {footer}
    </form>
  );
}
