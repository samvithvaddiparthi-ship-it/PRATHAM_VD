'use client';
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog behaviour, shared by every overlay in the app.
 *
 * Returns a ref to put on the dialog panel. While the panel is mounted it:
 *   • traps Tab / Shift+Tab inside the panel, so a keyboard user cannot land on
 *     the page behind an overlay they think they are blocked by,
 *   • closes on Escape,
 *   • moves focus into the panel on open, and
 *   • restores focus to whatever opened it on close.
 *
 * The caller still supplies the ARIA: role="dialog" (or "alertdialog"),
 * aria-modal="true", and aria-labelledby pointing at the panel's heading.
 *
 * `initialFocus` picks what gets focus on open:
 *   'first'  — the first focusable node (right for form modals: land in the form)
 *   'safe'   — the LAST focusable node is skipped and the first is used, but for
 *              confirmations you want Cancel, so pass a ref via `focusRef`
 * Pass `focusRef` to focus a specific element instead.
 */
export function useDialogA11y(onClose, { focusRef } = {}) {
  const panelRef = useRef(null);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll(FOCUSABLE);
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement;
    const target = focusRef?.current || panelRef.current?.querySelector(FOCUSABLE);
    target?.focus();
    return () => { if (opener instanceof HTMLElement) opener.focus(); };
    // focusRef is a ref object; its identity is stable, so open-once semantics hold.
  }, [focusRef]);

  return panelRef;
}
