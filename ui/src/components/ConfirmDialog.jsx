import Modal from './Modal';

// A yes/no question with a real button for each answer. Replaces the native
// confirm(), which blocks the whole tab, cannot be styled, and on some phones
// is silently suppressed after the first one.
export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }) {
  return (
    <Modal onClose={onCancel} maxWidth={420} zIndex={1100} label={title} style={{ padding: '24px 26px' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
      {message && <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{message}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button type="button" className="btn btn-outline" onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} autoFocus
                style={danger ? { background: 'var(--danger, #ef4444)', borderColor: 'var(--danger, #ef4444)', color: '#fff' } : undefined}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
