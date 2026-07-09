'use client';
import { useState, useCallback } from 'react';

/**
 * Lightweight transient notices that replace native alert() for non-blocking
 * messages ("copied", "saved", "failed").
 *
 * Usage:
 *   const { toast, toastView } = useToast();
 *   toast('QR copied');                 // info
 *   toast('Save failed', 'error');      // error
 *   return (<> ...page... {toastView} </>);
 */
// `fg` on `bg` clears 4.5:1 in all three cases (info 7.88, success 4.66, error 4.63).
const COLORS = {
  info:    { bg: '#EBF5FB', fg: '#1B4F72', border: '#AED6F1' },
  success: { bg: '#D5F5E3', fg: '#1C7943', border: '#A9DFBF' },
  error:   { bg: '#FADBD8', fg: '#B43628', border: '#F1948A' },
};

export function useToast() {
  const [toasts, setToasts] = useState([]);

  const toast = useCallback((message, type = 'info', ms = 3500) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ms);
  }, []);

  const toastView = (
    <div style={{ position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1100, alignItems: 'center', pointerEvents: 'none' }}>
      {toasts.map(t => {
        const c = COLORS[t.type] || COLORS.info;
        // Errors interrupt (assertive); "copied"/"saved" wait their turn (polite).
        // A failed save announced politely can be superseded and never read out.
        const isError = t.type === 'error';
        return (
          <div key={t.id} role={isError ? 'alert' : 'status'} aria-live={isError ? 'assertive' : 'polite'} style={{
            background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
            borderRadius: 10, padding: '10px 16px', fontSize: 13, fontWeight: 600,
            boxShadow: '0 4px 14px rgba(0,0,0,0.15)', maxWidth: 360,
          }}>
            {t.message}
          </div>
        );
      })}
    </div>
  );

  return { toast, toastView };
}
