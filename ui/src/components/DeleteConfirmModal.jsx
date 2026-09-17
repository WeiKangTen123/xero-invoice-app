import Modal from './Modal';

/**
 * Reusable modal for confirming destructive deletions.
 * Supports single invoice/receipt deletion and bulk deletion.
 */
export default function DeleteConfirmModal({
  isOpen,
  title = 'Delete Confirmation',
  message,
  itemName,
  isExpense = false,
  count = 1,
  confirmLabel = 'Delete',
  loading = false,
  onConfirm,
  onClose,
}) {
  if (!isOpen) return null;

  const defaultMessage = count > 1
    ? `Are you sure you want to delete these ${count} items? This will permanently remove them from the database and delete all associated files.`
    : `Are you sure you want to delete this ${isExpense ? 'expense receipt' : 'invoice'}${itemName ? ` ("${itemName}")` : ''}? This will permanently remove the record and any uploaded image or PDF.`;

  return (
    <Modal onClose={onClose} busy={loading} maxWidth={440} zIndex={1100} label={title} style={{ padding: '24px 26px', maxHeight: 'none' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 12,
              background: 'rgba(239, 68, 68, 0.12)',
              color: 'var(--danger, #ef4444)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            🗑
          </div>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' }}>
              {title}
            </h3>
            <p
              style={{
                margin: '8px 0 0',
                fontSize: 13,
                lineHeight: 1.5,
                color: 'var(--text-muted)',
              }}
            >
              {message || defaultMessage}
            </p>
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '10px 14px',
            fontSize: 12,
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 20,
          }}
        >
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span>This action cannot be undone.</span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={loading}
            style={{
              background: 'var(--danger, #ef4444)',
              borderColor: 'var(--danger, #ef4444)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {loading ? (
              <>
                <span className="btn-spinner" />
                <span>Deleting...</span>
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
    </Modal>
  );
}
