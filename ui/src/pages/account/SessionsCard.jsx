import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import ResultNote from '../../components/ResultNote';

// Every other device signed in as this account, signed out from here — for a
// laptop left open somewhere, or a password that was shared and should not
// have been. This device stays: signOutEverywhere stores the fresh token the
// server returns, as a password change does.
export default function SessionsCard({ idx = 1 }) {
  const { signOutEverywhere } = useAuth();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [msg,  setMsg]  = useState(null);

  async function signOutOthers() {
    const ok = await confirm({
      title: 'Sign out everywhere?',
      message: 'Every other device signed in to this account is signed out. This one stays signed in.',
      confirmLabel: 'Sign out everywhere',
    });
    if (!ok) return;
    setBusy(true); setMsg(null);
    try {
      await signOutEverywhere();
      setMsg({ ok: true, text: 'Every other device is signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        }}>🖥</div>
        <div>
          <div className="card-title">Sessions</div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>
            Other devices are signed out when you change your password. This signs them out without changing it.
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-outline" onClick={signOutOthers} disabled={busy}>
          {busy ? <><span className="btn-spinner" /> Signing out…</> : '⇥ Sign out everywhere'}
        </button>
        <ResultNote msg={msg} />
      </div>
    </div>
  );
}
