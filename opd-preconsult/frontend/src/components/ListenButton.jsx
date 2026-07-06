'use client';
import { useState, useEffect, useRef } from 'react';
import { getToken } from '../lib/api';

// Read-aloud (text-to-speech) for low-literacy / elderly patients.
// Primary: Bhashini TTS via /api/tts (natural Indian-language voices, on-shore).
// Fallback: the browser's SpeechSynthesis if Bhashini is unreachable.
//
// `segments` (optional) lets the caller split speech into parts — e.g. the
// question, then each answer option — played as separate clips with a pause
// between, so options are clearly distinct (used by Assisted mode). If only
// `text` is given, it's spoken as one clip.
// `autoPlay` speaks automatically whenever the content changes (Assisted mode).
const LANG_MAP = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' };
const PLAYBACK_RATE = { en: 1.0, hi: 0.85, te: 0.85 };  // slow hi/te a little
const GAP_MS = 950;                                     // pause between segments

export default function ListenButton({ text, segments, lang = 'en', label = 'Listen', autoPlay = false }) {
  const [busy, setBusy] = useState(false);
  const audioRef = useRef(null);
  const resolveRef = useRef(null);   // force-resolve the in-flight clip on stop
  const cancelRef = useRef(false);
  const lastSpoke = useRef('');

  const parts = (segments && segments.length ? segments : (text ? [text] : [])).filter(Boolean);
  const key = parts.join(' || ');

  useEffect(() => () => stopAll(), []);

  useEffect(() => {
    if (autoPlay && key && key !== lastSpoke.current) {
      lastSpoke.current = key;
      playSequence();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, key]);

  function stopAll() {
    cancelRef.current = true;
    try { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; } } catch {}
    if (resolveRef.current) { const r = resolveRef.current; resolveRef.current = null; r(); }
    try { if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel(); } catch {}
    setBusy(false);
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function fetchAudio(part) {
    // /api/tts is auth-gated now; attach the login token. Read from getToken()
    // with a sessionStorage fallback (autoPlay can fire before the page's
    // setToken() runs, since child effects run before parent effects).
    const headers = { 'Content-Type': 'application/json' };
    const tok = getToken() || (typeof window !== 'undefined' ? sessionStorage.getItem('token') : null);
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const res = await fetch('/api/tts', {
      method: 'POST', headers,
      body: JSON.stringify({ text: part, lang }),
    });
    if (!res.ok) throw new Error('tts ' + res.status);
    return res.blob();
  }

  function playBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.playbackRate = PLAYBACK_RATE[lang] || 0.9;
      audioRef.current = audio;
      resolveRef.current = resolve;
      audio.onended = () => { URL.revokeObjectURL(url); audioRef.current = null; resolveRef.current = null; resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio')); };
      audio.play().catch(reject);
    });
  }

  // Browser-TTS fallback: queue parts back-to-back (uses commas/pauses natively).
  function browserFallback() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) { setBusy(false); return; }
    try {
      window.speechSynthesis.cancel();
      parts.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        u.lang = LANG_MAP[lang] || 'en-IN';
        u.rate = lang === 'en' ? 0.95 : 0.85;
        if (i === parts.length - 1) u.onend = () => setBusy(false);
        window.speechSynthesis.speak(u);
      });
    } catch { setBusy(false); }
  }

  async function playSequence() {
    if (!parts.length) return;
    stopAll();
    cancelRef.current = false;
    setBusy(true);
    try {
      for (let i = 0; i < parts.length; i++) {
        if (cancelRef.current) return;
        const blob = await fetchAudio(parts[i]);
        if (cancelRef.current) return;
        await playBlob(blob);
        if (cancelRef.current) return;
        if (i < parts.length - 1) await sleep(GAP_MS);
      }
    } catch {
      if (!cancelRef.current) browserFallback();
      return;
    }
    setBusy(false);
  }

  function onClick() { busy ? stopAll() : playSequence(); }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: busy ? 'var(--secondary)' : 'transparent',
        color: busy ? '#fff' : 'var(--secondary)',
        border: '1.5px solid var(--secondary)', borderRadius: 20,
        padding: '6px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
      }}
    >
      {busy ? '⏹ Stop' : '🔊 ' + label}
    </button>
  );
}
