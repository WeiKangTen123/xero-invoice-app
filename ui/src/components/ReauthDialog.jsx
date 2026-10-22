import { useState } from 'react';
import { api } from '../api/client';
import Modal from './Modal';
import CodeInput from '../pages/account/CodeInput';
import { reauthText, reauthBody, reauthReady } from '../pages/account/two-step';

// "Confirm it's you", asked before a sensitive admin action goes through
// (context/ReauthContext.jsx opens it for a 403 reauth_required). With 2-step
// sign-in on it asks for a code from the app, with the password offered
// instead; otherwise the password. POST /auth/reauth checks it; a refusal is
// said here and another try allowed. Confirmed, the action is sent again;
// Cancel (or Escape) gives the action its original error.
export default function ReauthDialog({ hasCode = false, onConfirmed, onCancel }) {
  const [useCode, setUseCode] = useState(hasCode);
  const [value,   setValue]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const text  = reauthText(useCode);
  const ready = reauthReady(useCode, value);

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/reauth', reauthBody(useCode, value));
      onConfirmed();
    } catch (err) {
      setValue('');
      setError(err.message || 'Could not confirm it is you. Try again.');
      setBusy(false);
    }
  }

  function switchMethod() {
    setUseCode(v => !v);
    setValue('');
    setError('');
  }

  return (
    <Modal onClose={onCancel} busy={busy} maxWidth={400} zIndex={1150} label="Confirm it's you" style={{ padding: '24px 26px' }}>
      <form onSubmit={submit}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Confirm it&apos;s you</div>
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' }}>{text.intro}</div>

        {error && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>
            <span className="alert-icon">✕</span>{error}
          </div>
        )}

        <div className="form-group" style={{ marginTop: 14, marginBottom: 0 }}>
          <label htmlFor="reauth-input" className="form-label">{text.label}</label>
          {useCode ? (
            <CodeInput id="reauth-input" value={value} onChange={setValue} autoFocus disabled={busy} />
          ) : (
            <input id="reauth-input" type="password" className="form-input" autoComplete="current-password"
                   value={value} onChange={e => setValue(e.target.value)} autoFocus disabled={busy} />
          )}
        </div>

        {hasCode && (
          <button type="button" onClick={switchMethod} disabled={busy}
                  style={{ marginTop: 10, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}>
            {text.toggle}
          </button>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
            {busy ? <><span className="btn-spinner" /> Checking…</> : text.button}
          </button>
        </div>
      </form>
    </Modal>
  );
}
