'use client';
import { useEffect, useState } from 'react';
import { t } from '../lib/i18n';

// Persistent, app-wide "investigational — not for clinical use" notice. Required
// until each AI component is formally validated. Self-localises from the patient's
// chosen language (sessionStorage 'lang'), and falls back to English on clinician
// surfaces (doctor / HIS) where no patient language is set.
export default function Disclaimer() {
  const [lang, setLang] = useState('en');

  useEffect(() => {
    const read = () => { try { setLang(sessionStorage.getItem('lang') || 'en'); } catch {} };
    read();
    // Layout persists across route changes, so poll to pick up the language the
    // patient selects after this bar first mounts. Cheap (one string read/sec).
    const id = setInterval(read, 1000);
    window.addEventListener('storage', read);
    return () => { clearInterval(id); window.removeEventListener('storage', read); };
  }, []);

  return (
    <div
      role="note"
      aria-live="polite"
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60,
        background: '#FBEEE6', color: '#8A4B1F', borderTop: '1px solid #EBD3C0',
        fontSize: 12, lineHeight: 1.35, textAlign: 'center',
        padding: '6px 12px', paddingBottom: 'calc(6px + env(safe-area-inset-bottom))',
      }}
    >
      ⚠️ {t('disclaimer', lang)}
    </div>
  );
}
