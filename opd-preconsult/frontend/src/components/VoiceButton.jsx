'use client';
import { useState, useRef, useEffect } from 'react';

export default function VoiceButton({ onResult, lang = 'en' }) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState(true);
  const recRef = useRef(null);

  const langMap = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };

  // Detect browser support after mount (window isn't available during SSR).
  useEffect(() => {
    setSupported('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);
  }, []);

  function toggle() {
    if (!supported) return;

    if (recording) {
      recRef.current?.stop();
      setRecording(false);
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SpeechRecognition();
    rec.lang = langMap[lang] || 'en-IN';
    rec.continuous = false;
    rec.interimResults = false;

    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      onResult(text);
      setRecording(false);
    };
    rec.onerror = () => setRecording(false);
    rec.onend = () => setRecording(false);

    recRef.current = rec;
    rec.start();
    setRecording(true);
  }

  return (
    <button className={`voice-btn ${recording ? 'recording' : ''}`} onClick={toggle} type="button"
      disabled={!supported}
      title={supported ? 'Tap to speak' : 'Voice input is not supported in this browser'}
      aria-label={supported ? 'Record voice input' : 'Voice input not supported in this browser'}
      style={!supported ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}>
      🎤
    </button>
  );
}
