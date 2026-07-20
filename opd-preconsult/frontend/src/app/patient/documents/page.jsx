'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '../../../lib/api';
import { t, tf } from '../../../lib/i18n';
import ProgressBar from '../../../components/ProgressBar';

const DOC_TYPES = [
  { value: 'prescription', label_en: 'Prescription', label_hi: 'प्रिस्क्रिप्शन', label_te: 'ప్రిస్క్రిప్షన్' },
  { value: 'lab_report', label_en: 'Lab Report / Blood Report', label_hi: 'लैब / ब्लड रिपोर्ट', label_te: 'ల్యాబ్ / బ్లడ్ రిపోర్ట్' },
  { value: 'discharge_summary', label_en: 'Discharge Summary', label_hi: 'डिस्चार्ज समरी', label_te: 'డిశ్చార్జ్ సమ్మరీ' },
  { value: 'diagnostic_report', label_en: 'ECG / Echo / X-ray / CT / MRI', label_hi: 'ECG / Echo / X-ray / CT / MRI', label_te: 'ECG / Echo / X-ray / CT / MRI' },
  { value: 'other', label_en: 'Other', label_hi: 'अन्य', label_te: 'ఇతర' },
];

export default function Documents() {
  const router = useRouter();
  const [lang, setLang] = useState('en');
  const [sessionId, setSessionId] = useState('');
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedType, setSelectedType] = useState('prescription');
  const [skipWarning, setSkipWarning] = useState(false);
  const [mustReview, setMustReview] = useState(false);   // uploaded doc(s) not yet reviewed
  const [error, setError] = useState('');
  // Hospital-wide OCR flag (HIS admin → Settings). null = still loading. Uploading
  // stays available either way — when false the file is stored and passed to the
  // doctor as-is, and only the AI extraction/review UI is hidden (there is nothing
  // extracted to confirm). Default true if the read fails.
  const [ocrEnabled, setOcrEnabled] = useState(null);

  useEffect(() => {
    setLang(sessionStorage.getItem('lang') || 'en');
    const token = sessionStorage.getItem('token');
    if (token) setToken(token);
    const sid = sessionStorage.getItem('session_id');
    setSessionId(sid || '');
    api.getPublicSettings()
      .then(s => setOcrEnabled(s.ocr_enabled !== false))
      .catch(() => setOcrEnabled(true));
  }, []);

  async function handleUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.uploadDocument(file, sessionId, selectedType);
      // With OCR off there's no extraction to review, so the upload is complete
      // as soon as it's stored — mark it done (no ✓/✗ review step).
      setDocs(prev => [...prev, { ...result, type: selectedType, confirmed: ocrEnabled === false }]);
    } catch (err) {
      setError(t('upload_failed', lang) + ': ' + (err.message || 'Unknown error'));
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  }

  // Both review actions are authenticated writes: on failure the local state must
  // stay put (the server did not record it) and the patient must be told, or the
  // ✓/✗ buttons look dead — the same silent failure the consent Agree button had.
  async function handleConfirm(idx) {
    const doc = docs[idx];
    if (!doc.doc_id) return;
    setError('');
    try {
      await api.confirmDocument(doc.doc_id, true);
    } catch (err) {
      setError(err.message || 'Unknown error');
      return;
    }
    setDocs(prev => prev.map((d, i) => i === idx ? { ...d, confirmed: true } : d));
    setMustReview(false);   // they're reviewing — clear the nudge
  }

  async function handleReject(idx) {
    const doc = docs[idx];
    if (!doc.doc_id) return;
    setError('');
    try {
      await api.confirmDocument(doc.doc_id, false);
    } catch (err) {
      setError(err.message || 'Unknown error');
      return;
    }
    setDocs(prev => prev.filter((_, i) => i !== idx));
    setMustReview(false);
  }

  const langKey = (dt) => dt[`label_${lang}`] || dt.label_en;

  return (
    <div className="screen">
      <ProgressBar stepId="documents" lang={lang} />
      <div className="card" style={{ gap: 16 }}>
        <h2 style={{ textAlign: 'center', color: 'var(--primary)' }}>{t('documents_title', lang)}</h2>
        <p style={{ color: 'var(--text-light)', textAlign: 'center', fontSize: 'calc(14px * var(--fs, 1))', lineHeight: 1.5 }}>{t('documents_desc', lang)}</p>

        {/* When OCR is off, patients can still upload — the files are stored and
            shown to the doctor as-is (no AI reading). An info chip sets that
            expectation so they don't wait for an on-screen summary. */}
        {ocrEnabled === false && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#EFF4F8', border: '1px solid #DCE6EE', borderRadius: 10,
            padding: '10px 14px', color: 'var(--text-light)',
            fontSize: 'calc(13px * var(--fs, 1))', lineHeight: 1.5,
          }}>
            <span aria-hidden style={{ fontSize: 'calc(16px * var(--fs, 1))', flexShrink: 0 }}>📎</span>
            <span>{t('documents_passthrough_note', lang)}</span>
          </div>
        )}

        {/* Document type selector */}
        <div>
          <label style={{ fontSize: 13, color: 'var(--text-light)', marginBottom: 4, display: 'block' }}>{t('doc_type', lang)}</label>
          <select className="input" value={selectedType} onChange={e => setSelectedType(e.target.value)}>
            {DOC_TYPES.map(dt => (
              <option key={dt.value} value={dt.value}>{langKey(dt)}</option>
            ))}
          </select>
        </div>

        {/* Upload button */}
        <label className="btn btn-secondary" style={{ position: 'relative' }}>
          {loading ? t('processing', lang) : `📎 ${t('upload', lang)}`}
          <input
            type="file"
            accept="image/*,application/pdf"
            onChange={handleUpload}
            disabled={loading}
            style={{ position: 'absolute', opacity: 0, width: '100%', height: '100%', top: 0, left: 0, cursor: 'pointer' }}
          />
        </label>

        {error && (
          <div style={{ background: '#FADBD8', color: '#C0392B', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginTop: 12 }}>
            {error}
          </div>
        )}

        {/* Uploaded documents list */}
        {docs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ fontWeight: 600, fontSize: 14 }}>{tf(docs.length === 1 ? 'docs_uploaded_one' : 'docs_uploaded_many', lang, { n: docs.length })}</p>

            {docs.map((doc, idx) => (
              <div key={idx} style={{
                background: doc.confirmed ? '#E8F8F5' : '#F8F9FA',
                borderRadius: 12, padding: 14,
                border: doc.confirmed ? '2px solid var(--accent)' : '1px solid #E0E0E0',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, textTransform: 'capitalize' }}>
                    {doc.type.replace('_', ' ')}
                  </span>
                  {ocrEnabled !== false && (
                    <span style={{
                      fontSize: 11, fontWeight: 600,
                      color: (doc.confidence || 0) >= 0.8 ? '#1E8449' : (doc.confidence || 0) >= 0.5 ? '#B9770E' : '#C0392B',
                    }}>
                      {(doc.confidence_source || doc.structured?.confidence_source) === 'text_scan' ? t('confidence_text_scan', lang) : t('confidence_ai', lang)}: {Math.round((doc.confidence || 0) * 100)}%
                    </span>
                  )}
                  {ocrEnabled === false
                    ? <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>✓ {t('uploaded_label', lang)}</span>
                    : (doc.confirmed && <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>✓ {t('confirmed', lang)}</span>)}
                </div>

                {/* Extraction details — only when OCR is on. When off there's no
                    extraction to show/confirm; the raw file just goes to the doctor. */}
                {ocrEnabled !== false && (<>
                {/* Scrollable review area — a long prescription or lab report can be
                    scrolled through here instead of being clipped/hidden. */}
                <div style={{ maxHeight: 240, overflowY: 'auto', paddingRight: 4, marginBottom: 8 }}>
                {/* Warn when AI extraction was unavailable and we fell back to basic text scan */}
                {doc.structured?.extraction_source === 'regex_fallback' && (
                  <div style={{ background: '#FFF4E5', border: '1px solid #FFB74D', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                    <p style={{ fontSize: 12, color: '#E65100', fontWeight: 600 }}>⚠ {t('ai_unavailable_title', lang)}</p>
                    <p style={{ fontSize: 11, color: '#E65100' }}>
                      {t('ai_unavailable_body', lang)}
                    </p>
                  </div>
                )}

                {/* Medications */}
                {doc.structured?.medications?.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>{t('medications_label', lang)}</p>
                    {doc.structured.medications.map((m, i) => (
                      <p key={i} style={{ fontSize: 13, marginLeft: 8 }}>
                        • {m.name}{m.dose ? ` ${m.dose}` : ''}{m.frequency ? ` · ${m.frequency}` : ''}{m.duration ? ` · ${m.duration}` : ''}
                        {m.instructions ? <span style={{ color: 'var(--text-light)' }}> ({m.instructions})</span> : null}
                      </p>
                    ))}
                  </div>
                )}

                {/* Lab values */}
                {doc.structured?.lab_values?.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>{t('lab_results_label', lang)}</p>
                    {doc.structured.lab_values.map((l, i) => (
                      <p key={i} style={{ fontSize: 13, marginLeft: 8, color: l.is_abnormal ? 'var(--red)' : 'inherit' }}>
                        • {l.test}: {l.value} {l.unit || ''}{l.is_abnormal ? ' ⚠' : ''}
                        {l.reference_range ? <span style={{ fontSize: 11, color: 'var(--text-light)' }}> (ref: {l.reference_range})</span> : null}
                      </p>
                    ))}
                  </div>
                )}

                {/* Allergies extracted from the document */}
                {doc.structured?.allergies?.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)' }}>{t('allergies_label', lang)}</p>
                    {doc.structured.allergies.map((a, i) => (
                      <p key={i} style={{ fontSize: 13, marginLeft: 8 }}>• {a}</p>
                    ))}
                  </div>
                )}

                {/* Raw text preview — full text (scrolls inside the review area above,
                    no longer clipped to ~200 chars). */}
                {!doc.structured?.medications?.length && !doc.structured?.lab_values?.length && !doc.structured?.allergies?.length && doc.raw_text && (
                  <p style={{ fontSize: 12, color: 'var(--text-light)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                    {doc.raw_text}
                  </p>
                )}
                </div>

                {/* Confirm / Reject buttons */}
                {!doc.confirmed && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      className="btn btn-accent"
                      style={{ flex: 1, minHeight: 40, fontSize: 13 }}
                      onClick={() => handleConfirm(idx)}
                    >
                      ✓ {t('correct', lang)}
                    </button>
                    <button
                      className="btn btn-outline"
                      style={{ flex: 1, minHeight: 40, fontSize: 13, borderColor: 'var(--red)', color: 'var(--red)' }}
                      onClick={() => handleReject(idx)}
                    >
                      ✗ {t('remove', lang)}
                    </button>
                  </div>
                )}
                </>)}
              </div>
            ))}
          </div>
        )}

        <div style={{ flex: 1 }} />
        {ocrEnabled !== false && mustReview && (
          <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center', lineHeight: 1.4 }}>
            {t('review_docs_first', lang)}
          </p>
        )}
        {ocrEnabled !== false && skipWarning && !mustReview && (
          <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center' }}>
            {t('skip_no_docs', lang)}
          </p>
        )}
        <button className="btn btn-primary" onClick={() => {
          // OCR off → nothing to upload/review here, just continue.
          if (ocrEnabled === false) { router.push('/patient/interview'); return; }
          // Every uploaded document must be reviewed (✓ Correct or ✗ Remove) before
          // continuing — the patient confirms whether each extraction is accurate.
          if (docs.some(d => !d.confirmed)) { setMustReview(true); return; }
          if (docs.length === 0 && !skipWarning) { setSkipWarning(true); return; }
          // Continue to the health questionnaire.
          router.push('/patient/interview');
        }}>
          {t('next', lang)}
        </button>
        <button className="btn btn-outline" onClick={() => router.push('/patient/register')}>
          ← {t('go_back', lang)}
        </button>
      </div>
    </div>
  );
}
