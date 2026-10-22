import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import PublicShell from './login/PublicShell';
import { emailFromSearch, resetByEmail, ASK_ADMIN_TEXT } from './login/login';
import { resendWait, resendLabel, emailProblem, sentText, FORM_TEXT } from './login/forgot-password';

// "Forgot your password?" from the sign-in page, when this server can send
// email (GET /auth/status → mail). An address in, a reset link out, and the
// same answer whether or not an account uses the address. Outside the
// sign-in guard (App.jsx). The words and the timing are in
// login/forgot-password.js (main/scripts/forgot-password-ui.test.js runs them).
const MUTED = 'var(--text-muted)';
const BACK = { fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' };

export default function ForgotPassword() {
  const location = useLocation();
  // The address typed on the sign-in page comes along, so it is not typed twice.
  const [email, setEmail]     = useState(() => emailFromSearch(location.search));
  const [touched, setTouched] = useState(false);
  // null until the server says whether it can send email at all.
  const [mail, setMail]       = useState(null);
  const [sentTo, setSentTo]   = useState('');
  const [sentAt, setSentAt]   = useState(null);
  const [now, setNow]         = useState(() => Date.now());
  const [sending, setSending] = useState(false);
  const [error, setError]     = useState('');

  // A server that cannot send email has no link to send: the page says who
  // to ask instead of promising an email that never comes. A check that
  // fails shows the form; sending then says what is wrong.
  useEffect(() => {
    let live = true;
    api.get('/auth/status')
      .then(d => { if (live) setMail(resetByEmail(d)); })
      .catch(() => { if (live) setMail(true); });
    return () => { live = false; };
  }, []);

  // Send another link comes on a minute after the last; the clock ticks only
  // while it is waiting.
  const wait    = resendWait(sentAt, now);
  const waiting = wait > 0;
  useEffect(() => {
    if (!waiting) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting]);

  const problem = emailProblem(email);

  async function send(address) {
    setError('');
    setSending(true);
    try {
      await api.post('/auth/forgot-password', { email: address });
      const at = Date.now();
      setSentTo(address);
      setSentAt(at);
      setNow(at);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (problem) return;
    send(email.trim());
  }

  const errorBox = error && (
    <div className="alert alert-error" role="alert">
      <span className="alert-icon">✕</span>
      {error}
    </div>
  );
  const back = (
    <div style={{ marginTop: 16, textAlign: 'center' }}>
      <Link to="/login" style={BACK}>{FORM_TEXT.back}</Link>
    </div>
  );

  if (mail === null) {
    return (
      <PublicShell>
        <p role="status" style={{ fontSize: 13.5, color: MUTED, textAlign: 'center', padding: '18px 0', margin: 0 }}>Loading…</p>
      </PublicShell>
    );
  }

  if (mail === false) {
    return (
      <PublicShell>
        <h1 className="card-title" style={{ fontSize: 17, margin: '0 0 12px' }}>{FORM_TEXT.title}</h1>
        <div className="alert alert-info" role="status">
          <span className="alert-icon">ℹ</span>
          This server can&apos;t send email yet. {ASK_ADMIN_TEXT}
        </div>
        {back}
      </PublicShell>
    );
  }

  if (sentTo) {
    const text = sentText(sentTo);
    return (
      <PublicShell>
        <h1 className="card-title" style={{ fontSize: 17, margin: '0 0 12px' }}>{text.title}</h1>
        <div className="alert alert-success" role="status">
          <span className="alert-icon">✉</span>
          {text.text}
        </div>
        {errorBox}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
          <span>{text.hint}</span>
          <button type="button" className="btn btn-outline btn-sm" disabled={waiting || sending} onClick={() => send(sentTo)}>
            {sending ? 'Sending…' : resendLabel(wait)}
          </button>
        </div>
        {back}
      </PublicShell>
    );
  }

  const shown = touched ? problem : null;
  return (
    <PublicShell>
      <h1 className="card-title" style={{ fontSize: 17, margin: '0 0 4px' }}>{FORM_TEXT.title}</h1>
      <div className="card-subtitle">{FORM_TEXT.subtitle}</div>
      {errorBox}
      <form onSubmit={submit} noValidate>
        <div className="form-group" style={{ marginBottom: 18 }}>
          <label htmlFor="fp-email" className="form-label">Email address</label>
          <input id="fp-email"
            type="email"
            className="form-input"
            placeholder="you@company.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onBlur={() => { if (email.trim()) setTouched(true); }}
            required autoFocus
            autoComplete="username"
            inputMode="email"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-invalid={shown ? true : undefined}
            aria-describedby={shown ? 'fp-problem' : undefined}
          />
          {shown && <div id="fp-problem" role="alert" style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>{shown}</div>}
        </div>
        <button type="submit" className="btn btn-primary" disabled={sending}
                style={{ width: '100%', justifyContent: 'center', padding: '11px 0', fontSize: 14 }}>
          {sending ? <><span className="btn-spinner" /> Sending…</> : FORM_TEXT.button}
        </button>
      </form>
      {back}
    </PublicShell>
  );
}
