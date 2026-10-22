import { useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import PublicShell from './login/PublicShell';
import {
  tokenFromHash, linkFromAnswer, linkFromError, deadLinkView, formText, shownProblem, signInPath, doneText,
  LINK_CHECKING, LINK_DEAD, LINK_FAILED, LINK_DONE, NO_TOKEN,
} from './login/set-password';
import { passwordProblem, passwordChecklist } from './account/password-rules';

// Where an invite or a password-reset link lands: /set-password#t=<token>.
// Outside the sign-in guard (App.jsx), since the person has no password yet
// or has lost theirs; the token is the only credential, and it sets this one
// account's password once. The decisions and the words are in
// login/set-password.js (main/scripts/set-password-ui.test.js runs them).
// Setting the password does not sign anyone in: they sign in with it next,
// which is also when a password manager offers to save it.

// Read by a screen reader, not drawn.
const SR_ONLY = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };
const MUTED = 'var(--text-muted)';

export default function SetPassword() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  // The token, read once from the address as it arrived. The effect below
  // then takes it out of the address bar, history and all.
  const [token] = useState(() => tokenFromHash(window.location.hash));
  const [link, setLink]           = useState({ state: LINK_CHECKING });
  const [password, setPassword]   = useState('');
  const [show, setShow]           = useState(false);
  const [touched, setTouched]     = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [doneEmail, setDoneEmail] = useState('');

  // Before the first paint: the fragment never reaches a server, but it does
  // stay in the address bar, the history and a screenshot.
  useLayoutEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
  }, []);

  // Whose link it is and what for, or why it cannot be used. Retry asks again
  // with the token still held here, as the address no longer has it.
  const check = useCallback(() => {
    if (!token) { setLink(NO_TOKEN); return () => {}; }
    let live = true;
    setLink({ state: LINK_CHECKING });
    api.post('/auth/link-info', { token })
      .then(d => { if (live) setLink(linkFromAnswer(d)); })
      .catch(err => { if (live) setLink(linkFromError(err)); });
    return () => { live = false; };
  }, [token]);

  useEffect(() => check(), [check]);

  const email     = link.email || '';
  const problem   = passwordProblem(password, email);
  const shown     = shownProblem(problem, { touched, submitted });
  const checklist = passwordChecklist(password, email);

  async function submit(e) {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    if (problem) return;
    setSaving(true);
    try {
      const d = await api.post('/auth/set-password', { token, password });
      setDoneEmail(d.email || email);
      setLink(l => ({ ...l, state: LINK_DONE }));
    } catch (err) {
      // The link went while the form was open (used in another tab, or ran
      // out): the page says so in place of the form.
      if (err.status === 410) { setLink(linkFromError(err)); return; }
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // The sign-in page sends anyone already signed in on to the app, so a
  // session still open in this browser (an administrator trying the link,
  // or this account before its reset) is signed out first.
  async function goSignIn() {
    if (user) await logout();
    navigate(signInPath(doneEmail || email), { replace: true });
  }

  if (link.state === LINK_CHECKING) {
    return (
      <PublicShell>
        <p role="status" style={{ fontSize: 13.5, color: MUTED, textAlign: 'center', padding: '18px 0', margin: 0 }}>
          Checking your link…
        </p>
      </PublicShell>
    );
  }

  if (link.state === LINK_FAILED) {
    return (
      <PublicShell>
        <div className="card-title" style={{ marginBottom: 12 }}>Could not check your link</div>
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">✕</span>
          {link.message}
        </div>
        <button type="button" className="btn btn-primary" onClick={check} style={{ width: '100%', justifyContent: 'center' }}>
          Retry
        </button>
      </PublicShell>
    );
  }

  if (link.state === LINK_DEAD) {
    const view = deadLinkView(link.reason, link.purpose);
    return (
      <PublicShell>
        <h1 className="card-title" style={{ fontSize: 17, margin: '0 0 12px' }}>{view.title}</h1>
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">✕</span>
          {link.message}
        </div>
        {view.hint && <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 16px' }}>{view.hint}</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {view.forgot && (
            <Link to="/forgot-password" className="btn btn-primary" style={{ justifyContent: 'center' }}>Get a new reset link</Link>
          )}
          {view.signIn && (
            <Link to="/login" className="btn btn-primary" style={{ justifyContent: 'center' }}>Sign in</Link>
          )}
          {!view.signIn && (
            <Link to="/login" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textAlign: 'center', marginTop: 4 }}>← Back to sign in</Link>
          )}
        </div>
      </PublicShell>
    );
  }

  if (link.state === LINK_DONE) {
    const done = doneText(doneEmail || email, user?.email);
    return (
      <PublicShell>
        <h1 className="card-title" style={{ fontSize: 17, margin: '0 0 12px' }}>{done.title}</h1>
        <div className="alert alert-success" role="status">
          <span className="alert-icon">✓</span>
          {done.text}
        </div>
        {done.note && <p style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.55, margin: '0 0 14px' }}>{done.note}</p>}
        <button type="button" className="btn btn-primary" onClick={goSignIn} style={{ width: '100%', justifyContent: 'center' }} autoFocus>
          {done.button}
        </button>
      </PublicShell>
    );
  }

  // The link is good: the form.
  const text = formText(link);
  return (
    <PublicShell>
      <h1 className="card-title" style={{ fontSize: 17, margin: '0 0 4px' }}>{text.title}</h1>
      <div className="card-subtitle">{text.subtitle}</div>

      {error && (
        <div className="alert alert-error" role="alert">
          <span className="alert-icon">✕</span>
          {error}
        </div>
      )}

      <form onSubmit={submit} noValidate>
        {/* The account the password is for, shown, and also given to a
            password manager as the username to save the new password under:
            the hidden field is what it reads, as the shown one is not a field. */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div className="form-group">
          <div className="form-label">Email address</div>
          <div className="form-input" style={{ color: 'var(--text-secondary)', cursor: 'default', overflowWrap: 'anywhere' }}>
            {email}
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: 18 }}>
          <label htmlFor="sp-password" className="form-label">New password</label>
          <div style={{ position: 'relative' }}>
            <input id="sp-password"
              type={show ? 'text' : 'password'}
              className="form-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onBlur={() => { if (password) setTouched(true); }}
              required autoFocus
              autoComplete="new-password"
              aria-describedby={shown ? 'sp-rules sp-problem' : 'sp-rules'}
              aria-invalid={shown ? true : undefined}
              style={{ paddingRight: 64 }}
            />
            <button
              type="button"
              onClick={() => setShow(v => !v)}
              aria-pressed={show}
              aria-label={show ? 'Hide password' : 'Show password'}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px',
                fontSize: 12, fontWeight: 600, color: 'var(--accent)',
              }}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>

          {/* The rules, ticked off as they are met. Read with the field. */}
          <ul id="sp-rules" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, fontSize: 12, lineHeight: 1.7 }}>
            {checklist.map(c => (
              <li key={c.key} style={{ color: c.ok ? 'var(--success)' : MUTED }}>
                <span aria-hidden="true" style={{ display: 'inline-block', width: 16 }}>{c.ok ? '✓' : '○'}</span>
                {c.label}
                <span style={SR_ONLY}>{c.ok ? ' (met)' : ' (not yet)'}</span>
              </li>
            ))}
          </ul>
          {shown && (
            <div id="sp-problem" role="alert" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{shown}</div>
          )}
        </div>

        <button type="submit" className="btn btn-primary" disabled={saving}
                style={{ width: '100%', justifyContent: 'center', padding: '11px 0', fontSize: 14 }}>
          {saving ? <><span className="btn-spinner" /> Saving…</> : text.button}
        </button>
      </form>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <Link to="/login" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}>← Back to sign in</Link>
      </div>
    </PublicShell>
  );
}
