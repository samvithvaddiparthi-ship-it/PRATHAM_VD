'use client';

// Shared digital-prescription renderer. Driven by a hospital template config
// (branding / theme / toggles) plus the prescription data. Used by BOTH the
// patient-facing /rx/verify page and the HIS admin live preview, so they can
// never drift. Convention-mandated clinical fields (patient identity + date,
// the ℞ medication table with dose/frequency/duration, prescriber name +
// signature line, Rx id) are ALWAYS rendered regardless of the toggles.
import { formatPhoneDisplay } from '../lib/phone';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function addDays(iso, days) {
  const d = new Date(iso || Date.now());
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + (Number(days) || 0));
  // A very large day count overflows JS's max date range, making the Date
  // invalid — calling toISOString() on it would THROW and crash the page.
  if (isNaN(d.getTime())) return '';
  return d.toISOString();
}

export default function RxDocument({ rx = {}, template = {}, verified = null }) {
  const t = template || {};
  const show = t.show || {};
  const accent = t.accent || '#1c5d8c';
  const modern = t.theme === 'modern';
  const items = rx.items || [];

  // Patient sub-line (age · gender · phone) per toggles.
  const patientBits = [];
  if (show.patient_age && rx.patient_age != null && rx.patient_age !== '') patientBits.push(`${rx.patient_age}y`);
  if (show.patient_gender && rx.patient_gender) patientBits.push(({ M: 'Male', F: 'Female', O: 'Other' }[rx.patient_gender] || rx.patient_gender));
  if (show.patient_phone && rx.patient_phone) patientBits.push(formatPhoneDisplay(rx.patient_phone));

  const muted = '#64748b';
  const line = '#e2e8f0';

  return (
    <div style={{ fontFamily: modern ? 'Arial, sans-serif' : 'Georgia, "Times New Roman", serif', color: '#0f172a' }}>
      {/* Verified badge (only when explicitly verified true/false) */}
      {verified === true && (
        <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 10, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontFamily: 'Arial, sans-serif' }}>
          <span style={{ fontSize: 18 }}>✅</span>
          <div>
            <p style={{ color: '#047857', fontWeight: 700, fontSize: 13, margin: 0 }}>Verified prescription</p>
            <p style={{ color: '#059669', fontSize: 11, margin: 0 }}>Signature valid · issued by {t.hospital_name || 'the hospital'}</p>
          </div>
        </div>
      )}

      {/* ── Header / branding ── */}
      <div style={{
        textAlign: modern ? 'left' : 'center',
        borderLeft: modern ? `4px solid ${accent}` : 'none',
        paddingLeft: modern ? 12 : 0,
        paddingBottom: 12, marginBottom: 12, borderBottom: `2px solid ${accent}`,
        display: 'flex', alignItems: 'center', gap: 12, justifyContent: modern ? 'flex-start' : 'center',
      }}>
        {show.logo && t.logo_url ? (
          <img src={t.logo_url} alt="" style={{ height: 46, width: 46, objectFit: 'contain', borderRadius: 6 }} />
        ) : null}
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: accent, lineHeight: 1.1 }}>{t.hospital_name || 'Hospital'}</div>
          {t.tagline ? <div style={{ fontSize: 11, color: muted, fontStyle: 'italic' }}>{t.tagline}</div> : null}
          {t.address ? <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>{t.address}</div> : null}
          {(t.phone || t.email) ? (
            <div style={{ fontSize: 11, color: muted }}>
              {[t.phone, t.email].filter(Boolean).join('  ·  ')}
            </div>
          ) : null}
          {t.registration_line ? <div style={{ fontSize: 10, color: muted, marginTop: 2 }}>{t.registration_line}</div> : null}
        </div>
      </div>

      {/* ── Patient + date ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <span style={{ fontSize: 16, fontWeight: 700 }}>{rx.patient || 'Patient'}</span>
          {patientBits.length > 0 && (
            <span style={{ fontSize: 12, color: muted, marginLeft: 8 }}>{patientBits.join(' · ')}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: muted, textAlign: 'right', whiteSpace: 'nowrap', fontFamily: 'Arial, sans-serif' }}>
          {fmtDate(rx.issued_at || rx.date)}
          {rx.issued_at && <><br /><span style={{ fontSize: 11 }}>{fmtTime(rx.issued_at)}</span></>}
        </div>
      </div>

      {/* ── Prescriber ── */}
      <p style={{ fontSize: 12, color: muted, margin: '4px 0 14px' }}>
        Prescribed by <strong style={{ color: '#334155' }}>{rx.doctor || 'Doctor'}</strong>
        {show.department && rx.department ? ` · ${rx.department} Dept.` : ''}
        {show.doctor_registration && rx.doctor_registration ? ` · Reg. ${rx.doctor_registration}` : ''}
      </p>

      {/* ── ℞ Medications (always shown) ── */}
      <p style={{ fontSize: 13, fontWeight: 700, color: accent, marginBottom: 6 }}>℞ Medications</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontFamily: 'Arial, sans-serif' }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${line}` }}>
            {['Drug', 'Dose', 'Freq', 'Duration'].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 4px', color: muted, fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={4} style={{ padding: 10, color: muted, textAlign: 'center', fontStyle: 'italic' }}>No medication prescribed — advice only</td></tr>
          ) : items.map((it, i) => (
            <tr key={i} style={{ borderBottom: `1px solid #f1f5f9` }}>
              <td style={{ padding: '8px 4px', fontWeight: 600 }}>
                {it.drug || it.drug_name || '—'}
                {(it.instructions) && <div style={{ fontWeight: 400, fontSize: 11, color: muted, marginTop: 2 }}>{it.instructions}</div>}
              </td>
              <td style={{ padding: '8px 4px' }}>{it.dose || '—'}</td>
              <td style={{ padding: '8px 4px' }}>{it.freq || it.frequency || '—'}</td>
              <td style={{ padding: '8px 4px' }}>{it.duration || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── Doctor's advice ── */}
      {rx.notes ? (
        <div style={{ marginTop: 16, borderTop: `1px solid ${line}`, paddingTop: 12 }}>
          <p style={{ fontSize: 13, fontWeight: 700, color: accent, marginBottom: 4 }}>Doctor's Advice &amp; Instructions</p>
          <p style={{ fontSize: 13, color: '#334155', lineHeight: 1.5, whiteSpace: 'pre-wrap', fontFamily: 'Arial, sans-serif' }}>{rx.notes}</p>
        </div>
      ) : null}

      {/* ── Optional notices ── */}
      {show.generic_note && t.generic_note_text ? (
        <p style={{ fontSize: 11, color: muted, marginTop: 12, fontStyle: 'italic' }}>{t.generic_note_text}</p>
      ) : null}
      {show.valid_until ? (
        <p style={{ fontSize: 11, color: muted, marginTop: 6, fontFamily: 'Arial, sans-serif' }}>
          Valid until: <strong>{fmtDate(addDays(rx.issued_at || rx.date, t.valid_days))}</strong>
        </p>
      ) : null}

      {/* ── Signature line (always — prescriptions require one) ── */}
      <div style={{ marginTop: 28, display: 'flex', justifyContent: 'flex-end' }}>
        <div style={{ textAlign: 'center', minWidth: 180 }}>
          <div style={{ borderTop: '1px solid #94a3b8', paddingTop: 4, fontSize: 12, color: muted, fontFamily: 'Arial, sans-serif' }}>
            {rx.doctor || 'Prescriber'} — Signature
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ marginTop: 18, textAlign: 'center', borderTop: `1px solid #f1f5f9`, paddingTop: 10, fontFamily: 'Arial, sans-serif' }}>
        {rx.rx_id ? <p style={{ fontSize: 10, color: '#cbd5e1', fontFamily: 'monospace', margin: '0 0 4px' }}>Rx ID: {rx.rx_id}</p> : null}
        {t.footer ? <p style={{ fontSize: 10, color: '#94a3b8', margin: 0 }}>{t.footer}</p> : null}
      </div>
    </div>
  );
}
