'use client';
import { useState, useCallback, useRef } from 'react';

/**
 * Styled confirmation modal that replaces the browser's native confirm().
 * Mirrors the existing delete-confirmation modal styling in doctor/page.jsx.
 *
 * Usage:
 *   const { confirm, dialog } = useConfirm();
 *   ...
 *   if (!(await confirm({ title: 'Delete?', message: '…', danger: true }))) return;
 *   ...
 *   return (<> ...page... {dialog} </>);
 */
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel }) {
  return (
    <div onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--card-bg)', borderRadius: 12, padding: 24, maxWidth: 440, width: '90%', boxShadow: '0 8px 30px rgba(0,0,0,0.25)' }}>
        <h3 style={{ color: danger ? 'var(--red)' : 'var(--primary)', marginBottom: 12, fontSize: 18 }}>{title}</h3>
        {message && (
          <p style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 18, color: 'var(--text)' }}>{message}</p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline" style={{ fontSize: 13, padding: '8px 16px', minHeight: 'auto', width: 'auto' }}
            onClick={onCancel} disabled={busy}>
            {cancelLabel || 'Cancel'}
          </button>
          <button onClick={onConfirm} disabled={busy}
            style={{ background: danger ? 'var(--red)' : 'var(--primary)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1 }}>
            {busy ? 'Working…' : (confirmLabel || 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Promise-based confirm. `confirm(opts)` resolves true/false when the user acts.
 * Render the returned `dialog` once near the page root.
 */
export function useConfirm() {
  const [state, setState] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    resolver.current = resolve;
    setState(opts || {});
  }), []);

  const settle = useCallback((val) => {
    setState(null);
    if (resolver.current) { resolver.current(val); resolver.current = null; }
  }, []);

  const dialog = state
    ? <ConfirmDialog {...state} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
    : null;

  return { confirm, dialog };
}
