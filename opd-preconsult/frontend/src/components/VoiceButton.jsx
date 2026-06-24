'use client';
import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';

// Records the patient's answer as ONE continuous audio clip with pause/resume
// buffering (pause + resume append to the same recording, never a new clip).
// On Stop the single blob is handed to the parent for Bhashini transcription.
// onResult(audioBlob, durationMs). `labels` lets the parent localise the text.
// `onMicTap` (optional) intercepts the idle mic tap so the parent can, e.g.,
// ask which language to speak in first; the parent then calls start() via ref.
const VoiceButton = forwardRef(function VoiceButton({ onResult, labels = {}, onMicTap }, ref) {
  const [status, setStatus] = useState('idle');   // idle | recording | paused
  const [elapsed, setElapsed] = useState(0);       // active ms (excludes pauses)
  const [supported, setSupported] = useState(true);
  const mediaRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const accumRef = useRef(0);
  const segStartRef = useRef(0);
  const tickRef = useRef(null);
  // Always call the LATEST onResult — `start` is frozen by useImperativeHandle,
  // so without this it would call a stale onResult that captured an old language.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const L = {
    speak: labels.speak || 'Tap to speak',
    recording: labels.recording || 'Recording',
    paused: labels.paused || 'Paused',
    pause: labels.pause || 'Pause',
    resume: labels.resume || 'Resume',
    stop: labels.stop || 'Stop',
    noMic: labels.noMic || 'Microphone not available',
  };

  useEffect(() => {
    setSupported(typeof MediaRecorder !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
    return () => { clearInterval(tickRef.current); try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {} };
  }, []);

  // Let the parent trigger recording imperatively (after picking a language).
  useImperativeHandle(ref, () => ({ start }), []);

  function startTick() {
    clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setElapsed(accumRef.current + (segStartRef.current ? Date.now() - segStartRef.current : 0));
    }, 200);
  }

  function cleanup() {
    clearInterval(tickRef.current);
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
    segStartRef.current = 0;
    setElapsed(0);
    if (blob) onResultRef.current(blob, dur);
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
      startTick();
    } catch { setSupported(false); }
  }

  function pause() {
    const mr = mediaRef.current;
    if (mr && mr.state === 'recording') {
      try { mr.pause(); } catch {}
      accumRef.current += Date.now() - segStartRef.current;
      segStartRef.current = 0;
      clearInterval(tickRef.current);
      setStatus('paused');
    }
  }

  function resume() {
    const mr = mediaRef.current;
    if (mr && mr.state === 'paused') {
      try { mr.resume(); } catch {}
      segStartRef.current = Date.now();
      setStatus('recording');
      startTick();
    }
  }

  function stop() {
    const mr = mediaRef.current;
    if (mr && mr.state === 'recording') accumRef.current += Date.now() - segStartRef.current;
    clearInterval(tickRef.current);
    setStatus('idle');
    if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch { finish(); } }
    else finish();
  }

  const fmt = ms => { const s = Math.floor((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  if (!supported) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-light)', fontSize: 13, padding: 10 }}>🎤 {L.noMic}</div>
    );
  }

  if (status === 'idle') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={() => (onMicTap ? onMicTap() : start())} aria-label={L.speak}
          style={{ width: 64, height: 64, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: 'var(--secondary)', color: '#fff', fontSize: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 14px rgba(46,134,171,0.35)', transition: 'transform 0.1s' }}>🎤</button>
        <span style={{ fontSize: 13, color: 'var(--text-light)' }}>{L.speak}</span>
      </div>
    );
  }

  const recording = status === 'recording';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
      background: '#F7FAFC', border: '1px solid #E1EBF2', borderRadius: 14, padding: '14px 16px' }}>
      {/* status + timer */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: recording ? 'var(--red)' : 'var(--text-light)' }}>
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: recording ? 'var(--red)' : '#aab4bf',
          display: 'inline-block', animation: recording ? 'vbpulse 1s infinite' : 'none' }} />
        {recording ? L.recording : L.paused}
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text)', fontWeight: 700 }}>{fmt(elapsed)}</span>
      </div>
      {/* controls */}
      <div style={{ display: 'flex', gap: 10 }}>
        {recording ? (
          <button type="button" onClick={pause} style={ctrlBtn('#fff', 'var(--secondary)', 'var(--secondary)')}>⏸ {L.pause}</button>
        ) : (
          <button type="button" onClick={resume} style={ctrlBtn('var(--accent)', '#fff', 'var(--accent)')}>▶ {L.resume}</button>
        )}
        <button type="button" onClick={stop} style={ctrlBtn('var(--secondary)', '#fff', 'var(--secondary)')}>⏹ {L.stop}</button>
      </div>
      <style>{`@keyframes vbpulse { 0%,100%{opacity:1} 50%{opacity:.25} }`}</style>
    </div>
  );
});

export default VoiceButton;

function ctrlBtn(bg, color, border) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 108, justifyContent: 'center',
    background: bg, color, border: `1.5px solid ${border}`, borderRadius: 22, padding: '9px 16px',
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
  };
}
