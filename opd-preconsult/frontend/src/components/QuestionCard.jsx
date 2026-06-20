'use client';
import { useState, useEffect } from 'react';
import VoiceButton from './VoiceButton';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

// Questions that support contextual document uploads. `labelKey` is resolved
// against i18n so the button text follows the patient's chosen language.
const UPLOAD_CONFIG = {
  q_surgery_detail: { labelKey: 'upload_discharge', docType: 'discharge_summary' },
};

export default function QuestionCard({ question, lang, onAnswer, initialValue = '' }) {
  const [value, setValue] = useState(initialValue);
  const [uploading, setUploading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);
  const [inputError, setInputError] = useState('');
  const [transcribing, setTranscribing] = useState(false);   // Bhashini round-trip in progress
  const [detectedLang, setDetectedLang] = useState('');      // language detected from speech
  const [translation, setTranslation] = useState('');        // English translation (NMT)
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    setValue(initialValue);
    setInputError('');
    setTranscribing(false);
    setDetectedLang('');
    setTranslation(''); setShowTranslation(false); setTranslating(false);
  }, [question?.id]);

  // Any edit/new transcription invalidates a previously-fetched translation.
  function resetTranslation() { setTranslation(''); setShowTranslation(false); }

  // Friendly name for a detected language code.
  const langName = (code) => ({ en: 'English', hi: 'हिन्दी (Hindi)', te: 'తెలుగు (Telugu)' }[code] || code);

  const text = question[`text_${lang}`] || question.text_en;
  const options = question.options_json || [];
  const type = question.q_type;
  const uploadCfg = UPLOAD_CONFIG[question.id];

  function submit(val) {
    const answer = val || value;
    if (!answer && question.required) {
      setInputError(t('err_response_required', lang));
      return;
    }
    setInputError('');
    onAnswer(answer);
    setValue('');
    setOcrResult(null);
  }

  // Voice answer → Bhashini transcription in the SPOKEN language (Hindi stays
  // Hindi, Telugu stays Telugu). The text is APPENDED so the patient can speak
  // multiple times and also type. The clip is stored server-side for the doctor.
  async function handleVoiceResult(blob, durMs) {
    if (!blob) return;
    setTranscribing(true);
    setInputError('');
    let patientName = '';
    try { patientName = JSON.parse(sessionStorage.getItem('register_form') || '{}').patient_name || ''; } catch {}
    try {
      const sessionId = sessionStorage.getItem('session_id');
      const res = await api.transcribeVoice(blob, { lang, sessionId, questionId: question.id, patientName, durationMs: durMs });
      const t = (res && res.text || '').trim();
      if (t) { setValue(prev => (prev && prev.trim()) ? `${prev.trim()} ${t}` : t); setDetectedLang(res.lang || ''); resetTranslation(); }
      else setInputError(lang === 'hi' ? 'समझ नहीं पाए — कृपया फिर बोलें या टाइप करें।' : lang === 'te' ? 'వినలేకపోయాం — దయచేసి మళ్ళీ చెప్పండి లేదా టైప్ చేయండి.' : "Couldn't catch that — please speak again or type.");
    } catch {
      setInputError(lang === 'hi' ? 'ट्रांसक्रिप्शन विफल — कृपया टाइप करें।' : lang === 'te' ? 'ట్రాన్స్క్రిప్షన్ విఫలమైంది — దయచేసి టైప్ చేయండి.' : 'Transcription failed — please type your answer.');
    } finally {
      setTranscribing(false);
    }
  }

  function clearAnswer() {
    setValue('');
    setInputError('');
    setDetectedLang('');
    resetTranslation();
  }

  // Fetch (once) and toggle the English translation of the native transcript.
  async function handleShowTranslation() {
    if (showTranslation) { setShowTranslation(false); return; }
    if (translation) { setShowTranslation(true); return; }
    setTranslating(true);
    try {
      const r = await api.translateText(value, detectedLang);
      setTranslation((r && r.english) || '');
      setShowTranslation(true);
    } catch {
      setInputError(lang === 'hi' ? 'अनुवाद उपलब्ध नहीं।' : lang === 'te' ? 'అనువాదం అందుబాటులో లేదు.' : 'Translation unavailable.');
    } finally {
      setTranslating(false);
    }
  }

  const vLabels = {
    speak: lang === 'hi' ? 'बोलने के लिए दबाएँ' : lang === 'te' ? 'మాట్లాడటానికి నొక్కండి' : 'Tap to speak',
    recording: lang === 'hi' ? 'रिकॉर्डिंग' : lang === 'te' ? 'రికార్డింగ్' : 'Recording',
    paused: lang === 'hi' ? 'रुका हुआ' : lang === 'te' ? 'ఆపివేయబడింది' : 'Paused',
    pause: lang === 'hi' ? 'रोकें' : lang === 'te' ? 'ఆపు' : 'Pause',
    resume: lang === 'hi' ? 'जारी रखें' : lang === 'te' ? 'కొనసాగించు' : 'Resume',
    stop: lang === 'hi' ? 'पूर्ण' : lang === 'te' ? 'పూర్తి' : 'Done',
    noMic: lang === 'hi' ? 'माइक्रोफ़ोन उपलब्ध नहीं' : lang === 'te' ? 'మైక్రోఫోన్ అందుబాటులో లేదు' : 'Microphone not available',
  };

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setOcrResult(null);
    try {
      const sessionId = sessionStorage.getItem('session_id');
      const result = await api.uploadDocument(file, sessionId, uploadCfg.docType);
      setOcrResult(result);

      // Format OCR results into the answer text
      if (uploadCfg.docType === 'prescription' && result.structured?.medications?.length) {
        const medText = result.structured.medications.map(m => {
          let line = m.name;
          if (m.dose) line += ` ${m.dose}`;
          if (m.frequency) line += ` ${m.frequency}`;
          return line;
        }).join(', ');
        setValue(prev => prev ? `${prev}, ${medText}` : medText);
      } else if (result.raw_text) {
        setValue(prev => prev ? `${prev}\n${result.raw_text.slice(0, 300)}` : result.raw_text.slice(0, 300));
      }
    } catch (err) {
      setInputError(t('upload_failed', lang) + ': ' + (err.message || 'Unknown error'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="card" style={{ gap: 24, justifyContent: 'center' }}>
      <h2 style={{ fontSize: 20, lineHeight: 1.4, textAlign: 'center' }}>{text}</h2>

      {type === 'BOOLEAN' && (
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => submit('yes')}>
            {lang === 'hi' ? 'हाँ' : lang === 'te' ? 'అవును' : 'Yes'}
          </button>
          <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => submit('no')}>
            {lang === 'hi' ? 'नहीं' : lang === 'te' ? 'కాదు' : 'No'}
          </button>
        </div>
      )}

      {type === 'SINGLE_SELECT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {options.map(opt => (
            <button
              key={opt.value}
              className="btn btn-outline"
              onClick={() => submit(opt.value)}
            >
              {opt[`label_${lang}`] || opt.label_en}
            </button>
          ))}
        </div>
      )}

      {type === 'FREE_TEXT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {lang !== 'en' && (
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.3, color: 'var(--primary)' }}>
              {lang === 'hi' ? '🗣️ हिन्दी में आपका उत्तर' : '🗣️ తెలుగులో మీ సమాధానం'}
            </div>
          )}
          <textarea
            className="input"
            rows={3}
            value={value}
            onChange={e => { setValue(e.target.value); resetTranslation(); }}
            placeholder={lang === 'hi' ? 'बोलें या यहाँ टाइप करें...' : lang === 'te' ? 'మాట్లాడండి లేదా ఇక్కడ టైప్ చేయండి...' : 'Speak or type here...'}
          />

          {/* Show English translation — only when the answer is in Hindi/Telugu.
              On-demand Bhashini NMT (no LLM); fetched once then toggled. */}
          {detectedLang && detectedLang !== 'en' && value.trim() && (
            <div>
              <button type="button" onClick={handleShowTranslation} disabled={translating}
                style={{ background: 'none', border: 'none', color: 'var(--secondary)', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {translating ? (lang === 'hi' ? 'अनुवाद हो रहा है…' : lang === 'te' ? 'అనువదిస్తోంది…' : 'Translating…')
                  : showTranslation ? (lang === 'hi' ? '🌐 अनुवाद छिपाएँ' : lang === 'te' ? '🌐 అనువాదాన్ని దాచు' : '🌐 Hide translation')
                  : (lang === 'hi' ? '🌐 अंग्रेज़ी अनुवाद दिखाएँ' : lang === 'te' ? '🌐 ఆంగ్ల అనువాదం చూపించు' : '🌐 Show English translation')}
              </button>
              {showTranslation && translation && (
                <div style={{ marginTop: 8, background: '#F5F9FC', border: '1px solid #E1EBF2', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: 'var(--text-light)', textTransform: 'uppercase', marginBottom: 4 }}>English</div>
                  <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.4 }}>{translation}</div>
                </div>
              )}
            </div>
          )}

          {/* Microphone control */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, margin: '2px 0' }}>
            <VoiceButton onResult={handleVoiceResult} labels={vLabels} />
            {transcribing && (
              <span style={{ fontSize: 13, color: 'var(--secondary)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 13, height: 13, border: '2px solid #cfe0ec', borderTopColor: 'var(--secondary)', borderRadius: '50%', display: 'inline-block', animation: 'qcspin 0.7s linear infinite' }} />
                {lang === 'hi' ? 'लिख रहे हैं…' : lang === 'te' ? 'రాస్తున్నాం…' : 'Transcribing…'}
              </span>
            )}
            {!transcribing && detectedLang && (
              <span style={{ fontSize: 12, color: 'var(--text-light)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
                {lang === 'hi' ? 'पहचानी गई भाषा' : lang === 'te' ? 'గుర్తించిన భాష' : 'Detected language'}: <strong style={{ color: 'var(--text)' }}>{langName(detectedLang)}</strong>
              </span>
            )}
          </div>
          <style>{`@keyframes qcspin { to { transform: rotate(360deg) } }`}</style>

          {/* Contextual document upload */}
          {uploadCfg && (
            <div style={{ background: '#F0F8FF', border: '1px dashed #4A90D9', borderRadius: 10, padding: 12, textAlign: 'center' }}>
              <p style={{ fontSize: 12, color: 'var(--text-light)', marginBottom: 8 }}>
                {lang === 'hi' ? 'या दस्तावेज़ अपलोड करें' : lang === 'te' ? 'లేదా పత్రం అప్‌లోడ్ చేయండి' : 'Or upload document'}
              </p>
              <label style={{
                display: 'inline-block', background: 'var(--secondary)', color: '#fff',
                borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13,
                opacity: uploading ? 0.6 : 1,
              }}>
                {uploading ? t('processing', lang) : t(uploadCfg.labelKey, lang)}
                <input type="file" accept="image/*" capture="environment"
                  onChange={handleUpload} disabled={uploading}
                  style={{ display: 'none' }} />
              </label>
            </div>
          )}

          {/* OCR Results display */}
          {ocrResult && ocrResult.structured?.medications?.length > 0 && (
            <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 10, fontSize: 12 }}>
              <strong>{t('extracted_medications', lang)}</strong>
              <table style={{ width: '100%', marginTop: 6, fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #A9DFBF' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>{t('col_drug', lang)}</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>{t('col_dose', lang)}</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>{t('col_freq', lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {ocrResult.structured.medications.map((m, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #E8F8F5' }}>
                      <td style={{ padding: '4px 6px' }}>{m.name}</td>
                      <td style={{ padding: '4px 6px' }}>{m.dose || '-'}</td>
                      <td style={{ padding: '4px 6px' }}>{m.frequency || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {ocrResult && ocrResult.structured?.lab_values?.length > 0 && (
            <div style={{ background: '#FEF9E7', borderRadius: 8, padding: 10, fontSize: 12 }}>
              <strong>{t('extracted_lab_values', lang)}</strong>
              {ocrResult.structured.lab_values.map((l, i) => (
                <span key={i} style={{
                  display: 'inline-block', margin: '4px 4px 0 0', padding: '2px 8px',
                  borderRadius: 4, fontSize: 11,
                  background: l.is_abnormal ? '#FADBD8' : '#D5F5E3',
                  color: l.is_abnormal ? '#C0392B' : '#1E8449',
                }}>
                  {l.test}: {l.value} {l.is_abnormal ? `(${t('abnormal', lang)})` : ''}
                </span>
              ))}
            </div>
          )}

          {/allerg|medication|drug|medicine/i.test(question.text_en) && (
            <button className="btn btn-outline" style={{ width: '100%', fontSize: 13 }} onClick={() => submit('None')}>
              {lang === 'hi' ? 'कोई नहीं' : lang === 'te' ? 'ఏదీ లేదు' : 'None'}
            </button>
          )}
          {/* Clear + Done — equal size */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline" style={{ flex: 1, minHeight: 46 }} disabled={!value} onClick={clearAnswer}>
              {lang === 'hi' ? 'मिटाएँ' : lang === 'te' ? 'తుడిచివేయి' : 'Clear'}
            </button>
            <button className="btn btn-primary" style={{ flex: 1, minHeight: 46 }} onClick={() => submit()}>
              {lang === 'hi' ? 'पूर्ण' : lang === 'te' ? 'పూర్తయింది' : 'Done'}
            </button>
          </div>
          {inputError && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center' }}>{inputError}</p>}
        </div>
      )}

      {type === 'NUMERIC' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            type="number"
            className="input"
            value={value}
            onChange={e => setValue(e.target.value)}
          />
          <button className="btn btn-primary" onClick={() => submit()} disabled={!value}>
            {lang === 'hi' ? 'अगला' : lang === 'te' ? 'తదుపరి' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
}
