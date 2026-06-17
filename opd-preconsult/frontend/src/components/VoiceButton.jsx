'use client';
import { useState, useRef, useEffect } from 'react';

// Records the patient's spoken answer two ways at once:
//  1) the browser Speech API turns it into TEXT (unchanged behaviour), and
//  2) MediaRecorder keeps the ACTUAL audio so a doctor can listen back later
//     (and, later, so Bhashini can re-transcribe it server-side).
// onResult is called with (transcript, audioBlob, durationMs). audioBlob may be
// null if the device/browser can't record — text still works as before.
export default function VoiceButton({ onResult, lang = 'en' }) {
  const [recording, setRecording] = useState(false);
  const [supported, setSupported] = useState(true);
  const recRef = useRef(null);        // SpeechRecognition
  const mediaRef = useRef(null);      // MediaRecorder
  const streamRef = useRef(null);     // mic MediaStream (for cleanup)
  const chunksRef = useRef([]);
  const startRef = useRef(0);
  const transcriptRef = useRef('');

  const langMap = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };

  useEffect(() => {
    setSupported('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);
  }, []);

  function cleanupStream() {
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    streamRef.current = null;
  }

  // Build the audio blob (if any) and hand everything back to the parent.
  function finish() {
    const transcript = transcriptRef.current;
    const durationMs = startRef.current ? Date.now() - startRef.current : null;
    const chunks = chunksRef.current;
    if (transcript) {
      const blob = chunks.length ? new Blob(chunks, { type: mediaRef.current?.mimeType || 'audio/webm' }) : null;
      onResult(transcript, blob, durationMs);
    }
    chunksRef.current = [];
    transcriptRef.current = '';
    startRef.current = 0;
  }

  async function startAudioCapture() {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => { cleanupStream(); finish(); };
      mediaRef.current = mr;
      mr.start();
    } catch {
      // Mic capture blocked/unavailable — fall back to transcript only.
      mediaRef.current = null;
    }
  }

  function stopAll() {
    try { recRef.current?.stop(); } catch {}
    // Stopping the recorder triggers onstop → finish(). If there's no recorder,
    // finish() directly so the transcript still flows through.
    if (mediaRef.current && mediaRef.current.state !== 'inactive') {
      try { mediaRef.current.stop(); } catch { cleanupStream(); finish(); }
    } else {
      cleanupStream();
      finish();
    }
  }

  async function toggle() {
    if (!supported) return;

    if (recording) {
      setRecording(false);
      stopAll();
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SpeechRecognition();
    rec.lang = langMap[lang] || 'en-IN';
    rec.continuous = false;
    rec.interimResults = false;
    transcriptRef.current = '';

    rec.onresult = (e) => {
      transcriptRef.current = e.results[0][0].transcript;
      setRecording(false);
      stopAll();
    };
    rec.onerror = () => { setRecording(false); stopAll(); };
    rec.onend = () => { /* result/stop path handles finishing */ };

    recRef.current = rec;
    startRef.current = Date.now();
    await startAudioCapture();   // start mic capture first, then recognition
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
