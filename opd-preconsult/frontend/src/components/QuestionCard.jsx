'use client';
import { useState, useEffect } from 'react';
import VoiceButton from './VoiceButton';
import { api } from '../lib/api';

// Questions that support contextual document uploads
const UPLOAD_CONFIG = {
  q_surgery_detail: { label: 'Upload Discharge Summary', docType: 'discharge_summary' },
};

export default function QuestionCard({ question, lang, onAnswer, initialValue = '' }) {
  const [value, setValue] = useState(initialValue);
  const [uploading, setUploading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);
  const [inputError, setInputError] = useState('');
  const [transcribing, setTranscribing] = useState(false);   // Bhashini round-trip in progress
  const [correctionOffline, setCorrectionOffline] = useState(false); // Stage-2 LLM was down
  const [englishText, setEnglishText] = useState('');        // English view of the spoken answer

  useEffect(() => {
    setValue(initialValue);
    setInputError('');
    setEnglishText('');
    setCorrectionOffline(false);
  }, [question?.id]);

  const text = question[`text_${lang}`] || question.text_en;
  const options = question.options_json || [];
  const type = question.q_type;
  const uploadCfg = UPLOAD_CONFIG[question.id];

  function submit(val) {
    const answer = val || value;
    if (!answer && question.required) {
      setInputError('Please enter your response before continuing.');
      return;
    }
    setInputError('');
    onAnswer(answer);
    setValue('');
    setOcrResult(null);
  }

  // Voice answer: send the recorded audio to Bhashini (Stage 1 ASR + Stage 2
  // medical correction) and use the corrected text. The browser's own transcript
  // (`fallback`) is used only if the server transcription is unavailable. The
  // clip is stored server-side for doctor playback in the same call.
  // APPEND each spoken segment to the existing answer (the patient can speak
  // multiple times and also type). Shows both the local-language text and an
  // English view.
  async function handleVoiceResult(blob, durMs) {
    if (!blob) return;
    setTranscribing(true);
    setCorrectionOffline(false);
    setInputError('');
    let patientName = '';
    try { patientName = JSON.parse(sessionStorage.getItem('register_form') || '{}').patient_name || ''; } catch {}
    try {
      const sessionId = sessionStorage.getItem('session_id');
      const res = await api.transcribeVoice(blob, { lang, sessionId, questionId: question.id, patientName, durationMs: durMs });
      const local = (res && res.text || '').trim();
      if (local) setValue(prev => (prev && prev.trim()) ? `${prev.trim()} ${local}` : local);
      else setInputError(lang === 'hi' ? 'समझ नहीं पाए — कृपया फिर बोलें या टाइप करें।' : lang === 'te' ? 'వినలేకపోయాం — దయచేసి మళ్ళీ చెప్పండి లేదా టైప్ చేయండి.' : "Couldn't catch that — please speak again or type.");
      const en = (res && res.text_en || '').trim();
      if (en) setEnglishText(prev => prev ? `${prev} ${en}` : en);
      if (res && res.stage2_attempted && !res.llm_used) setCorrectionOffline(true);
    } catch {
      setInputError(lang === 'hi' ? 'ट्रांसक्रिप्शन विफल — कृपया टाइप करें।' : lang === 'te' ? 'ట్రాన్స్క్రిప్షన్ విఫలమైంది — దయచేసి టైప్ చేయండి.' : 'Transcription failed — please type your answer.');
    } finally {
      setTranscribing(false);
    }
  }

  function clearAnswer() {
    setValue('');
    setEnglishText('');
    setCorrectionOffline(false);
    setInputError('');
  }

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
      setInputError('Upload failed: ' + (err.message || 'Unknown error'));
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
          {/* The answer is captured in the patient's OWN language (the field
              below); the English translation appears under it. */}
          {lang !== 'en' && (
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: -6 }}>
              {lang === 'hi' ? 'हिन्दी (आपका उत्तर)' : lang === 'te' ? 'తెలుగు (మీ సమాధానం)' : ''}
            </div>
          )}
          <textarea
            className="input"
            rows={3}
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder={lang === 'hi' ? 'यहाँ टाइप करें...' : lang === 'te' ? 'ఇక్కడ టైప్ చేయండి...' : 'Type here...'}
          />

          {/* English view of what was said (shown alongside the local language). */}
          {englishText && lang !== 'en' && (
            <div style={{ background: '#F4F8FB', border: '1px solid #E1EBF2', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-light)', marginBottom: 2 }}>English</div>
              <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.45 }}>{englishText}</div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <VoiceButton onResult={handleVoiceResult} />
            {transcribing && (
              <span style={{ fontSize: 12, color: 'var(--secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 12, height: 12, border: '2px solid #cfe0ec', borderTopColor: 'var(--secondary)', borderRadius: '50%', display: 'inline-block', animation: 'qcspin 0.7s linear infinite' }} />
                {lang === 'hi' ? 'सुन रहे हैं…' : lang === 'te' ? 'వింటున్నాం…' : 'Transcribing…'}
              </span>
            )}
            {correctionOffline && !transcribing && (
              <span style={{ fontSize: 11.5, color: '#B9770E', background: '#FCF3CF', borderRadius: 6, padding: '3px 8px', textAlign: 'center', lineHeight: 1.4 }}>
                {lang === 'hi'
                  ? '⚠ स्मार्ट मेडिकल सुधार अभी उपलब्ध नहीं — कृपया टेक्स्ट जाँच लें।'
                  : lang === 'te'
                  ? '⚠ స్మార్ట్ మెడికల్ సరిదిద్దుబాటు అందుబాటులో లేదు — దయచేసి టెక్స్ట్ సరిచూసుకోండి.'
                  : '⚠ Smart medical correction is offline — please review the text.'}
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
                {uploading ? 'Processing...' : uploadCfg.label}
                <input type="file" accept="image/*" capture="environment"
                  onChange={handleUpload} disabled={uploading}
                  style={{ display: 'none' }} />
              </label>
            </div>
          )}

          {/* OCR Results display */}
          {ocrResult && ocrResult.structured?.medications?.length > 0 && (
            <div style={{ background: '#D5F5E3', borderRadius: 8, padding: 10, fontSize: 12 }}>
              <strong>Extracted medications:</strong>
              <table style={{ width: '100%', marginTop: 6, fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #A9DFBF' }}>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Drug</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Dose</th>
                    <th style={{ textAlign: 'left', padding: '4px 6px' }}>Freq</th>
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
              <strong>Extracted lab values:</strong>
              {ocrResult.structured.lab_values.map((l, i) => (
                <span key={i} style={{
                  display: 'inline-block', margin: '4px 4px 0 0', padding: '2px 8px',
                  borderRadius: 4, fontSize: 11,
                  background: l.is_abnormal ? '#FADBD8' : '#D5F5E3',
                  color: l.is_abnormal ? '#C0392B' : '#1E8449',
                }}>
                  {l.test}: {l.value} {l.is_abnormal ? '(abnormal)' : ''}
                </span>
              ))}
            </div>
          )}

          {/allerg|medication|drug|medicine/i.test(question.text_en) && (
            <button className="btn btn-outline" style={{ width: '100%', fontSize: 13 }} onClick={() => submit('None')}>
              {lang === 'hi' ? 'कोई नहीं' : lang === 'te' ? 'ఏదీ లేదు' : 'None'}
            </button>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" style={{ flex: 1 }} disabled={!value && !englishText} onClick={clearAnswer}>
              {lang === 'hi' ? 'मिटाएँ' : lang === 'te' ? 'తుడిచివేయి' : 'Clear'}
            </button>
            <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => submit()}>
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
