import { useState } from 'react';
import Modal from '../Modal';
import { api } from '../../api/client';
import AllowanceFields from './AllowanceFields';
import { ALLOWANCE_KINDS, emptyAllowanceForm, missingFields } from './allowance';

// Adds a mileage or per diem claim: a few typed fields, no receipt. The
// server prices it from the rate in Setup and keeps it for review like any
// claim; nothing here talks to Xero.
//
// `settings` is GET /claims/allowance/settings: the rate, the currency, and
// whether a payee is set. Without a payee the claim can be saved but not
// sent, since it is owed to the claimant and Xero needs their name.
export default function AllowanceClaimModal({ kind, settings, onClose, onAdded }) {
  const meta = ALLOWANCE_KINDS[kind];
  // The browser's own calendar day, which is the claimant's.
  const [form, setForm]     = useState(() => emptyAllowanceForm(kind, new Date().toLocaleDateString('en-CA')));
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const missing = missingFields(kind, form);

  function change(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  async function submit(e) {
    e.preventDefault();
    if (missing.length) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post('/claims/allowance', { kind, ...form });
      onAdded?.(res);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not add the claim');
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} busy={saving} maxWidth={480} label={`Add ${meta.label.toLowerCase()}`}>
      <form onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ fontSize: 22 }}>{meta.icon}</span>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Add {meta.label.toLowerCase()}</div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          No receipt needed. It is added for review like any claim, and posted to Xero as owed to you.
        </div>

        {!settings.payeeSet && (
          <div className="alert alert-warning" style={{ marginBottom: 12, fontSize: 12.5 }}>
            <span className="alert-icon">⚠</span>
            <span>Set “Your name for expense claims” in Setup before posting this: it is owed to you, and Xero needs your name.</span>
          </div>
        )}

        <AllowanceFields kind={kind} form={form} onChange={change} rate={settings[kind].rate}
          currency={settings.currency} disabled={saving} idPrefix={`add-${kind}`} />

        {error && (
          <div className="alert alert-error" style={{ marginTop: 12, marginBottom: 0 }}>
            <span className="alert-icon">✕</span>{error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16 }}>
          {missing.length > 0 && (
            <span style={{ fontSize: 11.5, color: 'var(--text-muted)', marginRight: 'auto' }}>Still needed: {missing.join(', ')}</span>
          )}
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving || missing.length > 0}>
            {saving ? 'Adding…' : `Add ${meta.label.toLowerCase()}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
