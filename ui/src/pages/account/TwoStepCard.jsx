import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import Modal from '../../components/Modal';
import ResultNote from '../../components/ResultNote';
import RetryAlert from '../../components/RetryAlert';
import { formatDate } from '../../utils/formatDate';
import CodeInput from './CodeInput';
import RecoveryCodes, { copyText } from './RecoveryCodes';
import {
  isFullCode, groupSecret, recoveryList, codesLeftText, codesLeftTone, stateFromStatus, canTurnOff, onSinceText,
  SETUP_STEPS, OFF_TEXT, REQUIRED_FOR_ADMINS,
  TWO_STEP_LOADING, TWO_STEP_OFF, TWO_STEP_SETUP, TWO_STEP_CODES, TWO_STEP_ON, TWO_STEP_FAILED,
} from './two-step';

const TONE = { red: 'var(--danger)', yellow: 'var(--warning)' };

// 2-step sign-in for the signed-in account, on the Account page: a code from
// an authenticator app after the password. Off → Set up (POST
// /auth/mfa/setup: a QR code and the secret behind it) → a code from the app
// turns it on (POST /auth/mfa/enable) → the ten recovery codes, shown once →
// on (GET /auth/mfa says since when and how many recovery codes are left).
// On, it makes new recovery codes (the password first) and, for anyone but
// an admin, turns off (the password and a code). The wording and the states
// are in two-step.js (main/scripts/mfa-ui.test.js).
//
// `setupRequired`: an admin who may do nothing else until it is on (the
// Account page's set-up mode). The server refuses most else meanwhile, so
// the card starts at Off without asking; `onSetUp` takes over once the
// recovery codes are saved (the page reloads the user and leaves).
export default function TwoStepCard({ idx = 1, setupRequired = false, onSetUp }) {
  const { user, refreshUser } = useAuth();
  const [view,    setView]    = useState(setupRequired ? TWO_STEP_OFF : TWO_STEP_LOADING);
  const [status,  setStatus]  = useState(null);
  const [loadErr, setLoadErr] = useState('');
  // The set-up under way ({ secret, otpauthUrl, qrSvg }) and the code typed.
  const [setup,   setSetup]   = useState(null);
  const [code,    setCode]    = useState('');
  // Recovery codes on screen, once.
  const [codes,   setCodes]   = useState(null);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [msg,     setMsg]     = useState(null);
  const [copied,  setCopied]  = useState('');
  // 'codes' (New recovery codes) or 'off' (Turn off): the dialog open.
  const [dialog,  setDialog]  = useState(null);

  const load = useCallback(async () => {
    setLoadErr('');
    try {
      const s = await api.get('/auth/mfa');
      setStatus(s);
      setView(stateFromStatus(s));
    } catch (err) {
      setLoadErr(err.message || 'Could not load 2-step sign-in');
      setView(TWO_STEP_FAILED);
    }
  }, []);

  useEffect(() => { if (!setupRequired) load(); }, [load, setupRequired]);

  async function startSetup() {
    setBusy(true); setError(''); setMsg(null); setCopied('');
    try {
      setSetup(await api.post('/auth/mfa/setup', {}));
      setCode('');
      setView(TWO_STEP_SETUP);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function enable(e) {
    e.preventDefault();
    if (!isFullCode(code) || busy) return;
    setBusy(true); setError('');
    try {
      const answer = await api.post('/auth/mfa/enable', { code });
      setSetup(null); setCode('');
      setCodes(recoveryList(answer.recoveryCodes));
      setView(TWO_STEP_CODES);
    } catch (err) {
      // The app's next code is a new one: the box starts again.
      setCode('');
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function cancelSetup() {
    setSetup(null); setCode(''); setError('');
    setView(TWO_STEP_OFF);
  }

  async function copySecret() {
    setCopied(await copyText(String(setup?.secret || '').replace(/\s/g, '')) ? 'Copied' : 'Could not copy: select it and press Ctrl+C');
  }

  // The codes are saved: they leave the page. The user is read again, so
  // what reads mfaEnabled off it ("Confirm it's you") knows it is on.
  async function codesDone() {
    setCodes(null);
    if (onSetUp) { await onSetUp(); return; }
    await refreshUser();
    await load();
  }

  async function newCodes({ password }) {
    const answer = await api.post('/auth/mfa/recovery-codes', { password });
    setDialog(null);
    setMsg(null);
    setCodes(recoveryList(answer.recoveryCodes));
    setView(TWO_STEP_CODES);
  }

  async function turnOff({ password, code: offCode }) {
    await api.post('/auth/mfa/disable', { password, code: offCode });
    setDialog(null);
    await refreshUser();
    await load();
    setMsg({ ok: true, text: '2-step sign-in is off.' });
  }

  const on       = view === TWO_STEP_ON;
  const left     = codesLeftText(status?.recoveryCodesLeft);
  const leftTone = codesLeftTone(status?.recoveryCodesLeft);
  const subtitle = view === TWO_STEP_SETUP ? 'Link an authenticator app to this account.'
    : view === TWO_STEP_CODES ? 'Your recovery codes, for a lost phone.'
    : on ? 'A code from your authenticator app is asked for after your password.'
    : OFF_TEXT;

  return (
    <div className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        }}>🛡</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div className="card-title">2-step sign-in</div>
            {on && <span className="badge badge-green">On</span>}
            {view === TWO_STEP_OFF && <span className="badge badge-gray">Off</span>}
          </div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>{subtitle}</div>
        </div>
      </div>

      {view === TWO_STEP_LOADING && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '12px 0', fontSize: 13 }}>
          <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
          Loading...
        </div>
      )}

      {view === TWO_STEP_FAILED && (
        <RetryAlert message={`Could not load 2-step sign-in. ${loadErr}`} onRetry={load} style={{ marginTop: 12 }} />
      )}

      {/* Turned off, "2-step sign-in is off." is said beside the button
          that turns it on again. */}
      {view === TWO_STEP_OFF && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary" onClick={startSetup} disabled={busy}>
            {busy ? <><span className="btn-spinner" /> Starting…</> : 'Set up 2-step sign-in'}
          </button>
          <ResultNote msg={msg} />
        </div>
      )}

      {view === TWO_STEP_SETUP && setup && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <img src={setup.qrSvg} alt="QR code for your authenticator app" width={180} height={180}
                 style={{ background: '#fff', padding: 8, borderRadius: 10, border: '1px solid var(--border)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                {SETUP_STEPS.map(step => <li key={step}>{step}</li>)}
              </ol>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>Can't scan it? Enter this key in the app instead:</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <code aria-label="Setup key" style={{ fontFamily: 'monospace', fontSize: 14, letterSpacing: '0.06em', padding: '6px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, overflowWrap: 'anywhere' }}>
                  {groupSecret(setup.secret)}
                </code>
                <button type="button" className="btn btn-outline btn-sm" onClick={copySecret}>Copy</button>
                {copied && <span role="status" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{copied}</span>}
              </div>
              {typeof setup.otpauthUrl === 'string' && setup.otpauthUrl.startsWith('otpauth://') && (
                <a href={setup.otpauthUrl} style={{ display: 'inline-block', marginTop: 8, fontSize: 12, color: 'var(--accent)' }}>
                  On your phone? Open it in your authenticator app
                </a>
              )}
            </div>
          </div>

          <form onSubmit={enable} style={{ marginTop: 16 }}>
            {error && (
              <div className="alert alert-error" role="alert" style={{ marginBottom: 12 }}>
                <span className="alert-icon">✕</span>{error}
              </div>
            )}
            <div className="form-group" style={{ marginBottom: 0, maxWidth: 240 }}>
              <label htmlFor="mfa-setup-code" className="form-label">6-digit code from the app</label>
              <CodeInput id="mfa-setup-code" value={code} onChange={setCode} disabled={busy} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="submit" className="btn btn-primary" disabled={busy || !isFullCode(code)}>
                {busy ? <><span className="btn-spinner" /> Checking…</> : 'Turn on'}
              </button>
              <button type="button" className="btn btn-outline" onClick={cancelSetup} disabled={busy}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {view === TWO_STEP_CODES && codes && (
        <div style={{ marginTop: 12 }}>
          <RecoveryCodes codes={codes} email={user?.email} timeZone={user?.timezone} onDone={codesDone} />
        </div>
      )}

      {on && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            {onSinceText(formatDate(status?.enabledAt, user?.timezone))}
            {left && <> · <span style={{ color: TONE[leftTone] || 'inherit' }}>{left}</span></>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-outline" onClick={() => { setMsg(null); setDialog('codes'); }}>
              New recovery codes
            </button>
            {canTurnOff(status, user) ? (
              <button type="button" className="btn btn-outline" onClick={() => { setMsg(null); setDialog('off'); }}
                      style={{ color: 'var(--danger)' }}>
                Turn off
              </button>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{REQUIRED_FOR_ADMINS}</span>
            )}
            <ResultNote msg={msg} />
          </div>
        </div>
      )}

      {dialog === 'codes' && (
        <AskDialog
          title="New recovery codes"
          intro="Your password, to make ten new recovery codes. The ones you have now stop working."
          withCode={false}
          submitLabel="Make new codes"
          onSubmit={newCodes}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === 'off' && (
        <AskDialog
          title="Turn off 2-step sign-in?"
          intro="Signing in will take only your password. Your password and a code from your app, to confirm."
          withCode
          danger
          submitLabel="Turn off"
          onSubmit={turnOff}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// The password (and, to turn it off, a code from the app) in a dialog. The
// server's refusal is said in it, and another try allowed.
function AskDialog({ title, intro, withCode, danger = false, submitLabel, onSubmit, onCancel }) {
  const [password, setPassword] = useState('');
  const [code,     setCode]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState('');
  const ready = !!password && (!withCode || isFullCode(code));

  async function submit(e) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      await onSubmit({ password, code });
    } catch (err) {
      setCode('');
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onCancel} busy={busy} maxWidth={420} label={title} style={{ padding: '24px 26px' }}>
      <form onSubmit={submit}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.5, color: 'var(--text-muted)' }}>{intro}</div>
        {error && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>
            <span className="alert-icon">✕</span>{error}
          </div>
        )}
        <div className="form-group" style={{ marginTop: 14, marginBottom: 0 }}>
          <label htmlFor="mfa-ask-password" className="form-label">Password</label>
          <input id="mfa-ask-password" type="password" className="form-input" autoComplete="current-password"
                 value={password} onChange={e => setPassword(e.target.value)} autoFocus disabled={busy} />
        </div>
        {withCode && (
          <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
            <label htmlFor="mfa-ask-code" className="form-label">6-digit code from your app</label>
            <CodeInput id="mfa-ask-code" value={code} onChange={setCode} disabled={busy} />
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ready}
                  style={danger ? { background: 'var(--danger, #ef4444)', borderColor: 'var(--danger, #ef4444)', color: '#fff', boxShadow: 'none' } : undefined}>
            {busy ? <><span className="btn-spinner" /> Checking…</> : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
