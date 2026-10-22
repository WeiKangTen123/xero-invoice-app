import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import CodeInput from '../account/CodeInput';
import { sanitizeRecoveryCode, recoveryCodeForSend, isRecoveryCode, isFullCode } from '../account/two-step';
import {
  MFA_CODE_PROMPT, MFA_RECOVERY_PROMPT, MFA_RECOVERY_HINT, canUseRecovery, verifyFailure, recoveryLeftToast,
} from './login';

// The sign-in card's second step, for an account with 2-step sign-in on: the
// password was right (Login.jsx holds the server's mfaToken in `challenge`),
// and now the code from the authenticator app, or one of the recovery codes.
// The wording and decisions are in login.js and account/two-step.js
// (main/scripts/mfa-ui.test.js). A code that is wrong may be tried again
// here; when the server says to start again (`restart: true`, or a lock),
// onRestart takes the card back to the email and password with its message.
// Signed in, onVerified takes the user on.
export default function MfaStep({ challenge, onVerified, onRestart, onBack, onError, muted }) {
  const { verifyMfa } = useAuth();
  const toast = useToast();
  const [useRecovery, setUseRecovery] = useState(false);
  const [code,     setCode]     = useState('');
  const [recovery, setRecovery] = useState('');
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);

  const recoveryOffered = canUseRecovery(challenge);
  const ready = useRecovery ? isRecoveryCode(recovery) : isFullCode(code);

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const proof = useRecovery ? { recoveryCode: recoveryCodeForSend(recovery) } : { code };
      const user  = await verifyMfa(challenge.mfaToken, proof);
      // A recovery code works once: say how many are left, and where to
      // make more once few are. The toast outlives this page.
      if (useRecovery) {
        const t = recoveryLeftToast(user?.recoveryCodesLeft);
        toast[t.kind](t.text);
      }
      onVerified(user);
    } catch (err) {
      const f = verifyFailure(err);
      if (f.restart) { onRestart(err, f.message); return; }
      // A wrong app code is typed again from the start; a recovery code is
      // kept, as one wrong character is the likelier mistake.
      if (!useRecovery) setCode('');
      setError(f.message);
      onError?.();
    } finally {
      setBusy(false);
    }
  }

  function switchMethod() {
    setUseRecovery(v => !v);
    setCode('');
    setRecovery('');
    setError('');
  }

  const linkButton = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' };

  return (
    <>
      {error && (
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">✕</span>
          {error}
        </div>
      )}

      <form onSubmit={submit}>
        <div className="form-group" style={{ marginBottom: 22, animation: 'fadeUp 0.3s ease 0ms both' }}>
          <label htmlFor={useRecovery ? 'mfa-recovery' : 'mfa-code'} className="form-label">
            {useRecovery ? MFA_RECOVERY_PROMPT : MFA_CODE_PROMPT}
          </label>
          {useRecovery ? (
            <input id="mfa-recovery"
              type="text"
              className="form-input"
              placeholder="xxxx-xxxx-xxxx"
              value={recovery}
              onChange={e => setRecovery(sanitizeRecoveryCode(e.target.value))}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
              aria-describedby="mfa-recovery-hint"
              style={{ fontFamily: 'monospace', fontSize: 15, letterSpacing: '0.05em' }}
            />
          ) : (
            <CodeInput id="mfa-code" value={code} onChange={setCode} autoFocus />
          )}
          {useRecovery && (
            <div id="mfa-recovery-hint" style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>
              {MFA_RECOVERY_HINT}
            </div>
          )}
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !ready}
          style={{ width: '100%', padding: '12px 0', fontSize: 15, fontWeight: 700, borderRadius: 10 }}
        >
          {busy ? <><span className="btn-spinner" /> Checking…</> : 'Verify'}
        </button>
      </form>

      <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
        {recoveryOffered && (
          <button type="button" onClick={switchMethod} disabled={busy} style={linkButton}>
            {useRecovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
          </button>
        )}
        <button type="button" onClick={onBack} disabled={busy} style={{ ...linkButton, fontWeight: 500, color: muted }}>
          ← Back to sign in
        </button>
      </div>
    </>
  );
}
