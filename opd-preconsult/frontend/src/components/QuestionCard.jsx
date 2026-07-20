'use client';
import { useState, useEffect, useRef } from 'react';
import VoiceButton from './VoiceButton';
import ListenButton from './ListenButton';
import Modal from './ui/Modal';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

// Questions that support contextual document uploads. `labelKey` is resolved
// against i18n so the button text follows the patient's chosen language.
const UPLOAD_CONFIG = {
  q_surgery_detail: { labelKey: 'upload_discharge', docType: 'discharge_summary' },
};

export default function QuestionCard({ question, lang, onAnswer, initialValue = '' }) {
  const [value, setValue] = useState(initialValue);
  // MULTI_SELECT keeps its own set of chosen values (submitted joined). Seeded from
  // initialValue so returning to an answered multi-select re-checks the picks.
  const [multi, setMulti] = useState(() => (initialValue ? String(initialValue).split(', ').filter(Boolean) : []));
  const [uploading, setUploading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);
  const [inputError, setInputError] = useState('');
  const [transcribing, setTranscribing] = useState(false);   // Bhashini round-trip in progress
  const [translation, setTranslation] = useState('');        // English translation (NMT)
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);
  // The language the patient chose to SPEAK in — picked ONCE on the first voice
  // question and reused on every mic after, so they're never re-asked mid-flow.
  // Persisted in sessionStorage keyed by session_id: it survives the card
  // unmounting between questions (the interview shows a loading state between
  // questions) AND a page refresh, but a NEW patient entry (new session_id) or a
  // closed tab starts fresh and asks again.
  const [voiceLang, setVoiceLang] = useState('');
  const [showLangPicker, setShowLangPicker] = useState(false);
  const voiceRef = useRef(null);        // imperative handle on VoiceButton (start)

  // Assisted mode (set in A11yProvider) → auto-read each question aloud.
  const [assist, setAssist] = useState(false);
  useEffect(() => {
    const read = () => { try { setAssist(localStorage.getItem('assistMode') === '1'); } catch {} };
    read();
    const onEvt = (e) => setAssist(!!e.detail);
    window.addEventListener('assistchange', onEvt);
    return () => window.removeEventListener('assistchange', onEvt);
  }, []);

  useEffect(() => {
    setValue(initialValue);
    setMulti(initialValue ? String(initialValue).split(', ').filter(Boolean) : []);
    setInputError('');
    setTranscribing(false);
    setTranslation(''); setShowTranslation(false); setTranslating(false);
  }, [question?.id]);

  // Restore the spoken-language choice for THIS session on mount, so every
  // question after the first one auto-uses it (no re-asking the language).
  useEffect(() => {
    try {
      const sid = sessionStorage.getItem('session_id') || '';
      const saved = sessionStorage.getItem('voice_lang_' + sid);
      if (saved) setVoiceLang(saved);
    } catch {}
  }, []);

  // Any edit/new transcription invalidates a previously-fetched translation.
  function resetTranslation() { setTranslation(''); setShowTranslation(false); }

  // Friendly name for a language code (own script).
  const langName = (code) => ({ en: 'English', hi: 'हिन्दी', te: 'తెలుగు' }[code] || code);

  // Mic tap: if a voice language is already chosen, record straight away;
  // otherwise ask which language to speak in first. Recording does NOT start on
  // its own — after choosing, the patient taps the mic again to begin.
  function handleMicTap() {
    if (voiceLang) { voiceRef.current?.start(); }
    else { setShowLangPicker(true); }
  }
  function chooseVoiceLang(code) {
    setVoiceLang(code);
    // Persist for the rest of this session so every following question's mic
    // auto-uses it (keyed by session_id → a new patient entry asks again).
    try {
      const sid = sessionStorage.getItem('session_id') || '';
      sessionStorage.setItem('voice_lang_' + sid, code);
    } catch {}
    setShowLangPicker(false);    // just set the language; patient taps mic to record
  }

  const text = question[`text_${lang}`] || question.text_en;
  const options = question.options_json || [];
  const type = question.q_type;
  const uploadCfg = UPLOAD_CONFIG[question.id];

  // Read aloud for low-literacy/elderly patients: the question first, then each
  // option as its OWN segment so they're spoken with a pause between (clearer in
  // Assisted mode than a single run-on sentence).
  const optionList = type === 'SINGLE_SELECT'
    ? options.map(o => o[`label_${lang}`] || o.label_en)
    : type === 'BOOLEAN'
      ? (lang === 'hi' ? ['हाँ', 'नहीं'] : lang === 'te' ? ['అవును', 'కాదు'] : ['Yes', 'No'])
      : [];
  const speakSegments = [text, ...optionList];
  const listenLabel = lang === 'hi' ? 'सुनें' : lang === 'te' ? 'వినండి' : 'Listen';

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
      const res = await api.transcribeVoice(blob, { lang: voiceLang || lang, sessionId, questionId: question.id, patientName, durationMs: durMs });
      const t = (res && res.text || '').trim();
      if (t) { setValue(prev => (prev && prev.trim()) ? `${prev.trim()} ${t}` : t); resetTranslation(); }
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
    resetTranslation();
  }

  // Fetch (once) and toggle the English translation of the native transcript.
  async function handleShowTranslation() {
    if (showTranslation) { setShowTranslation(false); return; }
    if (translation) { setShowTranslation(true); return; }
    setTranslating(true);
    try {
      const r = await api.translateText(value, voiceLang);
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
      <h2 style={{ fontSize: 'calc(20px * var(--fs, 1))', lineHeight: 1.4, textAlign: 'center' }}>{text}</h2>
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: -12 }}>
        <ListenButton segments={speakSegments} lang={lang} label={listenLabel} autoPlay={assist} />
      </div>

      {type === 'BOOLEAN' && (
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" style={{ flex: 1, gap: 8 }} onClick={() => submit('yes')}>
            <span aria-hidden="true">✓</span> {lang === 'hi' ? 'हाँ' : lang === 'te' ? 'అవును' : 'Yes'}
          </button>
          <button className="btn btn-outline" style={{ flex: 1, gap: 8 }} onClick={() => submit('no')}>
            <span aria-hidden="true">✗</span> {lang === 'hi' ? 'नहीं' : lang === 'te' ? 'కాదు' : 'No'}
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

          {/* Show English translation — only when the chosen voice language is
              Hindi/Telugu. On-demand Bhashini NMT (no LLM); fetched once then toggled. */}
          {voiceLang && voiceLang !== 'en' && value.trim() && (
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
            <VoiceButton ref={voiceRef} onResult={handleVoiceResult} onMicTap={handleMicTap} labels={vLabels} />
            {transcribing && (
              <span style={{ fontSize: 13, color: 'var(--secondary)', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 13, height: 13, border: '2px solid #cfe0ec', borderTopColor: 'var(--secondary)', borderRadius: '50%', display: 'inline-block', animation: 'qcspin 0.7s linear infinite' }} />
                {lang === 'hi' ? 'लिख रहे हैं…' : lang === 'te' ? 'రాస్తున్నాం…' : 'Transcribing…'}
              </span>
            )}
            {!transcribing && voiceLang && (
              <span style={{ fontSize: 12, color: 'var(--text-light)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
                {lang === 'hi' ? 'भाषा' : lang === 'te' ? 'భాష' : 'Language'}: <strong style={{ color: 'var(--text)' }}>{langName(voiceLang)}</strong>
                <button type="button" onClick={() => setShowLangPicker(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: 0, textDecoration: 'underline' }}>
                  {lang === 'hi' ? 'बदलें' : lang === 'te' ? 'మార్చు' : 'change'}
                </button>
              </span>
            )}
          </div>
          <style>{`@keyframes qcspin { to { transform: rotate(360deg) } }`}</style>

          {/* Voice-language picker — appears on the first mic tap; the chosen
              language applies to every mic for the rest of the session. */}
          {showLangPicker && (
            <Modal
              onClose={() => setShowLangPicker(false)}
              labelledBy="voice-lang-title"
              scrimStyle={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 60 }}
              panelStyle={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
                width: 320, maxWidth: '90vw', background: '#fff', borderRadius: 16, padding: 22, boxShadow: '0 12px 40px rgba(0,0,0,0.22)', textAlign: 'center' }}>
              <div aria-hidden="true" style={{ fontSize: 30, marginBottom: 6 }}>🎙️</div>
              <h3 id="voice-lang-title" style={{ fontSize: 16, color: 'var(--primary)', marginBottom: 16 }}>
                {lang === 'hi' ? 'आप किस भाषा में बोलेंगे?' : lang === 'te' ? 'మీరు ఏ భాషలో మాట్లాడతారు?' : 'Which language will you speak in?'}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[['en', 'English'], ['hi', 'हिंदी'], ['te', 'తెలుగు']].map(([code, label]) => (
                  <button key={code} type="button" onClick={() => chooseVoiceLang(code)}
                    style={{ height: 48, borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: 'pointer',
                      background: voiceLang === code ? 'var(--secondary)' : '#fff',
                      color: voiceLang === code ? '#fff' : 'var(--primary)',
                      border: `1.5px solid ${voiceLang === code ? 'var(--secondary)' : '#CBD5E0'}` }}>
                    {label}
                  </button>
                ))}
              </div>
            </Modal>
          )}

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
            <button className="btn btn-outline" style={{ width: '100%' }} onClick={() => submit('None')}>
              {lang === 'hi' ? 'कोई नहीं' : lang === 'te' ? 'ఏదీ లేదు' : 'None'}
            </button>
          )}
          {/* Clear + Done — equal size */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline" style={{ flex: 1 }} disabled={!value} onClick={clearAnswer}>
              {lang === 'hi' ? 'मिटाएँ' : lang === 'te' ? 'తుడిచివేయి' : 'Clear'}
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => submit()}>
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

      {type === 'MULTI_SELECT' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {options.map(opt => {
            const sel = multi.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                className={`btn ${sel ? 'btn-primary' : 'btn-outline'}`}
                style={{ gap: 8, justifyContent: 'flex-start' }}
                onClick={() => { setInputError(''); setMulti(prev => sel ? prev.filter(v => v !== opt.value) : [...prev, opt.value]); }}
              >
                <span aria-hidden="true">{sel ? '☑' : '☐'}</span>
                {opt[`label_${lang}`] || opt.label_en}
              </button>
            );
          })}
          {inputError && <p style={{ color: 'var(--red)', fontSize: 13, textAlign: 'center' }}>{inputError}</p>}
          <button
            className="btn btn-primary"
            style={{ marginTop: 4 }}
            onClick={() => {
              if (question.required && multi.length === 0) { setInputError(t('err_response_required', lang)); return; }
              setInputError('');
              onAnswer(multi.join(', '));
            }}
          >
            {lang === 'hi' ? 'अगला' : lang === 'te' ? 'తదుపరి' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
}
