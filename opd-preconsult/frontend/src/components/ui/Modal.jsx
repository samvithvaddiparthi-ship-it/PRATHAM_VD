'use client';
import { useDialogA11y } from './useDialogA11y';

/**
 * Scrim + accessible panel for overlays that are rendered inline (i.e. behind a
 * `{open && <Modal…>}` guard) rather than as their own component. Because Modal
 * only mounts when open, useDialogA11y's focus/restore effects are correctly
 * scoped to the modal's lifetime — calling the hook directly from the parent
 * would fire them on the parent's mount instead.
 *
 * The caller owns the visual styling and supplies `labelledBy`, the id of the
 * heading inside `children`.
 */
export default function Modal({
  onClose, labelledBy, describedBy, role = 'dialog',
  scrimStyle, panelStyle, children,
}) {
  const panelRef = useDialogA11y(onClose);
  return (
    <>
      <div onClick={onClose} style={scrimStyle} />
      <div ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        style={panelStyle}>
        {children}
      </div>
    </>
  );
}
