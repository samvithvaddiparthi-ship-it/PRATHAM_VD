'use client';
import { useState, useRef, useEffect } from 'react';

// Records the patient's spoken answer as ONE continuous audio clip (MediaRecorder)
// with PAUSE buffering — pause and resume append to the SAME recording, never a
// new clip. On Stop the single blob is handed to the parent, which sends it to
// Bhashini (Stage 1 ASR + Stage 2 medical correction). onResult(audioBlob, durationMs).
export default function VoiceButton({ onResult }) {
  const [status, setStatus] = useState('idle'); // idle | recording | paused
  const [supported, setSupported] = useState(true);
  const mediaRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const accumRef = useRef(0);    // total active (un-paused) ms
  const segStartRef = useRef(0); // start of the current active segment

  useEffect(() => {
    setSupported(typeof MediaRecorder !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  }, []);

  function cleanup() {
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    streamRef.current = null;
  }

  function finish() {
    const chunks = chunksRef.current;
    const blob = chunks.length ? new Blob(chunks, { type: mediaRef.current?.mimeType || 'audio/webm' }) : null;
    const dur = accumRef.current || null;
    cleanup();
    chunksRef.current = [];
    accumRef.current = 0;
    if (blob) onResult(blob, dur);
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      accumRef.current = 0;
      mr.ondataavailable = e => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => finish();
      mediaRef.current = mr;
      mr.start();
      segStartRef.current = Date.now();
      setStatus('recording');
    } catch {
      setSupported(false);
    }
  }

  function pause() {
    const mr = mediaRef.current;
    if (mr && mr.state === 'recording') {
      try { mr.pause(); } catch {}
      accumRef.current += Date.now() - segStartRef.current;
      setStatus('paused');
    }
  }

  function resume() {
    const mr = mediaRef.current;
    if (mr && mr.state === 'paused') {
      try { mr.resume(); } catch {}
      segStartRef.current = Date.now();
      setStatus('recording');
    }
  }

  function stop() {
    const mr = mediaRef.current;
    if (mr && mr.state === 'recording') accumRef.current += Date.now() - segStartRef.current;
    setStatus('idle');
    if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch { finish(); } }
    else finish();
  }

  if (!supported) {
    return (
      <button className="voice-btn" disabled title="Microphone is not available in this browser"
        style={{ opacity: 0.4, cursor: 'not-allowed' }}>🎤</button>
    );
  }

  const pill = (bg) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6, background: bg, color: '#fff',
    border: 'none', borderRadius: 22, padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  });

  if (status === 'idle') {
    return <button className="voice-btn" onClick={start} type="button" title="Tap to speak" aria-label="Record voice input">🎤</button>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {status === 'recording' ? (
        <button type="button" onClick={pause} style={pill('var(--secondary)')} aria-label="Pause recording">⏸ Pause</button>
      ) : (
        <button type="button" onClick={resume} style={pill('var(--accent)')} aria-label="Resume recording">▶ Resume</button>
      )}
      <button type="button" onClick={stop} style={pill('var(--red)')} aria-label="Stop recording">⏹ Stop</button>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-light)' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: status === 'recording' ? 'var(--red)' : '#bbb',
          display: 'inline-block', animation: status === 'recording' ? 'vbpulse 1s infinite' : 'none' }} />
        {status === 'recording' ? 'Recording' : 'Paused'}
      </span>
      <style>{`@keyframes vbpulse { 0%,100%{opacity:1} 50%{opacity:.3} }`}</style>
    </div>
  );
}
