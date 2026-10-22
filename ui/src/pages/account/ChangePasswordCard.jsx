import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import ResultNote from '../../components/ResultNote';
import { passwordProblem, passwordHint, setPasswordText, PASSWORD_MIN_LENGTH } from './password-rules';

// The signed-in account's own password, on the Account page: not a setting of
// the app, so not on Setup with them. Its own form and its own server call.
// The server signs out every other session this account has open; this one
// is kept because changePassword stores the fresh token it returns.
//
// `setPassword` is the mode for an account that must choose a new password,
// a temporary one from an administrator or its own one the rules now refuse
// (user.passwordChangeReason): the card says which, the current-password
// field is labelled to match, and on success `onPasswordSet` takes over (the
// page reloads the user and leaves).
export default function ChangePasswordCard({ idx = 0, setPassword = false, onPasswordSet }) {
  const { user, changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next,    setNext]    = useState('');
  const [again,   setAgain]   = useState('');
  const [show,    setShow]    = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [msg,     setMsg]     = useState(null);

  // The server's rules, checked here as typed (pages/account/password-rules.js)
  // so the button is off, and the reason shown, before anything is sent.
  const problem  = next ? passwordProblem(next, user?.email) : null;
  const mismatch = again && next !== again ? 'The new passwords do not match' : '';
  const valid    = !!current && !!next && !problem && again === next;
  const text     = setPasswordText(user?.passwordChangeReason);

  const fields = [
    { id: 'cp-current', label: setPassword ? text.current : 'Current password', value: current, set: setCurrent, autoComplete: 'current-password' },
    { id: 'cp-next',    label: 'New password',       value: next,  set: setNext,  autoComplete: 'new-password', minLength: PASSWORD_MIN_LENGTH, placeholder: passwordHint(), note: problem },
    { id: 'cp-again',   label: 'New password again', value: again, set: setAgain, autoComplete: 'new-password', minLength: PASSWORD_MIN_LENGTH, note: mismatch },
  ];

  async function submit(e) {
    e.preventDefault();
    if (!valid) { setMsg({ ok: false, text: problem || mismatch || 'Fill in every field' }); return; }
    setSaving(true); setMsg(null);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setAgain('');
      if (onPasswordSet) { await onPasswordSet(); return; }
      setMsg({ ok: true, text: 'Password changed. Any other device you were signed in on has been signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16, animation: `fadeUp 0.3s ease ${idx * 60}ms both` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0, background: 'var(--accent-subtle)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
        }}>🔑</div>
        <div>
          <div className="card-title">{setPassword ? 'Set a new password' : 'Change password'}</div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>
            {setPassword
              ? text.intro
              : 'The password you sign in with. Other devices are signed out.'}
          </div>
        </div>
      </div>
      <form onSubmit={submit} style={{ marginTop: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {fields.map(f => (
            <div className="form-group" key={f.id} style={{ marginBottom: 0 }}>
              <label htmlFor={f.id} className="form-label">{f.label}</label>
              <input
                id={f.id} type={show ? 'text' : 'password'} className="form-input"
                value={f.value} onChange={e => f.set(e.target.value)}
                required minLength={f.minLength} autoComplete={f.autoComplete} placeholder={f.placeholder}
                aria-invalid={f.note ? true : undefined}
              />
              {f.note && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>{f.note}</div>}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
          {passwordHint()}, no other rules.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={saving || !valid}>
            {saving ? <><span className="btn-spinner" /> Saving...</> : setPassword ? 'Set password' : 'Change password'}
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setShow(v => !v)}>
            {show ? '🙈 Hide' : '👁 Show'}
          </button>
          <ResultNote msg={msg} />
        </div>
      </form>
    </div>
  );
}
