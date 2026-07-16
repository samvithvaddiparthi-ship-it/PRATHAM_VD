'use client';
import { useState, useCallback, useRef, useId } from 'react';
import { useDialogA11y } from './useDialogA11y';

/**
 * Styled confirmation modal that replaces the browser's native confirm().
 *
 * This gates destructive, often irreversible actions, so it carries full dialog
 * semantics via useDialogA11y: announced as a modal, focus trapped while open,
 * Escape cancels, focus returns to whatever opened it.
 *
 * Options:
 *   danger        red heading, and a red confirm button — but only when there is
 *                 something to confirm. With `hideCancel` the lone button merely
 *                 dismisses, so it stays neutral; a red button would claim the
 *                 click destroys something.
 *   icon          emoji shown above the heading (decorative, aria-hidden).
 *   acknowledge   a checkbox the user must tick before Confirm enables. Use for
 *                 the truly irreversible ones, not as a speed bump on everything.
 *   confirmText   a string the user must type EXACTLY before Confirm enables (the
 *                 GitHub "type the repo name" pattern). Stronger than `acknowledge`:
 *                 it cannot be cleared by a reflex click, and naming the thing makes
 *                 you notice WHICH thing you are destroying. Reserve it for
 *                 permanent, unrecoverable deletion of a named object.
 *   hideCancel    one-button notice (role becomes alertdialog, centred layout).
 *                 `confirm()` still resolves — true on the button, false on
 *                 Escape/backdrop.
 *
 * Usage:
 *   const { confirm, dialog } = useConfirm();
 *   if (!(await confirm({ title: 'Delete?', message: '…', danger: true }))) return;
 *   return (<> ...page... {dialog} </>);
 */
export function ConfirmDialog({
  title, message, confirmLabel, cancelLabel, danger, busy, icon,
  acknowledge, confirmText, hideCancel, onConfirm, onCancel,
}) {
  const titleId = useId();
  const messageId = useId();
  const promptId = useId();
  const [acked, setAcked] = useState(false);
  const [typed, setTyped] = useState('');

  // Open on the safe control, never on the destructive one: a stray Enter must
  // not fire an action the user has not read yet. With no Cancel button, the
  // sole button is the safe one.
  const safeRef = useRef(null);
  const panelRef = useDialogA11y(onCancel, { focusRef: safeRef });

  const confirmBlocked = busy || (acknowledge && !acked) || (confirmText && typed !== confirmText);
  // An alert's only button dismisses; it destroys nothing. Painting it red would
  // claim otherwise. `danger` still colours the heading, which is where the
  // severity actually belongs.
  const destructiveButton = danger && !hideCancel;
  // One-button alerts read as a centred notice; confirmations read as a form.
  const centred = hideCancel;

  return (
    <div onClick={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div ref={panelRef}
        role={hideCancel ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--card-bg)', borderRadius: 12, padding: 24, maxWidth: 440, width: '90%', boxShadow: '0 8px 30px rgba(0,0,0,0.25)', textAlign: centred ? 'center' : 'left' }}>
        {icon && <div aria-hidden="true" style={{ fontSize: 'calc(34px * var(--fs, 1))', marginBottom: 8 }}>{icon}</div>}
        <h3 id={titleId} style={{ color: danger ? 'var(--red)' : 'var(--primary)', marginBottom: 12, fontSize: 'calc(18px * var(--fs, 1))' }}>{title}</h3>
        {message && (
          <p id={messageId} style={{ fontSize: 'calc(14px * var(--fs, 1))', lineHeight: 1.55, marginBottom: 18, color: 'var(--text)' }}>{message}</p>
        )}

        {acknowledge && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'calc(13px * var(--fs, 1))', marginBottom: 18, cursor: 'pointer' }}>
            <input type="checkbox" checked={acked} onChange={e => setAcked(e.target.checked)} style={{ marginTop: 2 }} />
            <span>{acknowledge}</span>
          </label>
        )}

        {confirmText && (
          <div style={{ marginBottom: 18 }}>
            <label htmlFor={promptId} style={{ display: 'block', fontSize: 'calc(13px * var(--fs, 1))', marginBottom: 6, color: 'var(--text)' }}>
              Type <strong style={{ fontFamily: 'monospace', userSelect: 'none' }}>{confirmText}</strong> to confirm
            </label>
            {/* autoComplete off + no autoFocus: focus stays on Cancel (the safe
                control), so a stray Enter cannot arm and fire the deletion. */}
            <input id={promptId} className="input" type="text" value={typed}
              onChange={e => setTyped(e.target.value)}
              autoComplete="off" spellCheck="false" disabled={busy}
              aria-describedby={messageId}
              style={{ fontFamily: 'monospace' }} />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: centred ? 'center' : 'flex-end' }}>
          {!hideCancel && (
            <button ref={safeRef} className="btn btn-outline" style={{ fontSize: 'calc(13px * var(--fs, 1))', padding: '8px 16px', minHeight: 'auto', width: 'auto' }}
              onClick={onCancel} disabled={busy}>
              {cancelLabel || 'Cancel'}
            </button>
          )}
          <button ref={hideCancel ? safeRef : undefined} onClick={onConfirm} disabled={confirmBlocked}
            style={{
              background: confirmBlocked ? '#ccc' : (destructiveButton ? 'var(--red)' : 'var(--primary)'),
              color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', minWidth: centred ? 120 : undefined,
              fontSize: 'calc(13px * var(--fs, 1))', cursor: confirmBlocked ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
            }}>
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

  const onConfirm = useCallback(() => settle(true), [settle]);
  const onCancel = useCallback(() => settle(false), [settle]);

  const dialog = state
    // Keyed so the acknowledge checkbox resets between openings — otherwise a
    // previously-ticked box would carry over and pre-arm the next deletion.
    ? <ConfirmDialog key={state.title} {...state} onConfirm={onConfirm} onCancel={onCancel} />
    : null;

  return { confirm, dialog };
}
