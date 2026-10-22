import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { api, SET_PASSWORD_PATH } from '../api/client';
import { returnPathFrom } from '../utils/returnTo';
import {
  lockMessage, lockCountdown, formFromStatus, registerRefusal,
  FORM_CHECKING, FORM_FIRST_RUN, FORM_UNREACHABLE, STATUS_FAILED_MESSAGE,
} from './login/login';
import { passwordProblem, passwordHint, PASSWORD_MIN_LENGTH } from './account/password-rules';

// Two modes. On first run the form creates the admin account (the server's
// /auth/register, which takes only the first account; after that it is
// refused and admins add users from Admin › Users). Ever after it signs in,
// and nothing on it offers to register: the tab that did led to a 403.
// Which one is asked of the server before either is shown (login/login.js).
export default function Login() {
  const { login, register } = useAuth();
  const { theme, toggle }   = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  // checking → first-run | sign-in, or unreachable with a Retry.
  const [form, setForm]       = useState(FORM_CHECKING);
  // Said when a first-run registration found an account already there and
  // the form became a sign-in form.
  const [notice, setNotice]   = useState('');
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  // The 423 the server answered with (pages/login/login.js#lockMessage) and a
  // clock that ticks while it lasts, so the button counts down and comes back
  // on its own at lockedUntil.
  const [lock, setLock]       = useState(null);
  const [now, setNow]         = useState(() => Date.now());
  const [forgot, setForgot]   = useState(false);

  const shakeTimer = useRef(null);
  const firstRun = form === FORM_FIRST_RUN;
  const mode = firstRun ? 'register' : 'login';

  // Resolves once the form is known, or known to be unreachable.
  const loadForm = useCallback(() => api.get('/auth/status')
    .then(d => setForm(formFromStatus(d)))
    .catch(() => setForm(FORM_UNREACHABLE)), []);

  useEffect(() => {
    loadForm();
    return () => clearTimeout(shakeTimer.current);
  }, [loadForm]);

  function retryForm() {
    setForm(FORM_CHECKING);
    loadForm();
  }

  useEffect(() => {
    if (!lock) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [lock]);

  const countdown = lock ? lockCountdown(lock.until, now) : { locked: false, text: '' };
  const locked    = countdown.locked;

  // The lock has run out: the form is a sign-in form again.
  useEffect(() => {
    if (lock && !locked) setLock(null);
  }, [lock, locked]);

  function shake() {
    setShaking(true);
    clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShaking(false), 600);
  }

  function triggerError(msg) {
    setError(msg);
    shake();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setNotice('');
    if (mode === 'register') {
      // The server's own rules, said before the request goes.
      const problem = passwordProblem(password, email);
      if (problem) { triggerError(problem); return; }
    }
    setLoading(true);
    try {
      const user = mode === 'login' ? await login(email, password) : await register(email, password);
      // A temporary password from an administrator must be replaced before
      // anything else; otherwise back to the page that sent you here, if it
      // was one of ours. Replaced rather than pushed, so Back from there does
      // not return to this form.
      navigate(user?.mustChangePassword ? SET_PASSWORD_PATH : returnPathFrom(location), { replace: true });
    } catch (err) {
      // 423: too many wrong passwords, and the server says until when. The
      // button is off until then; a right password is refused just the same
      // (unless from where this account has signed in before, which the
      // server lets through rather than answer 423).
      if (err.status === 423) {
        const l = lockMessage(err.body, Date.now());
        if (l) { setLock(l); setNow(Date.now()); setPassword(''); shake(); return; }
      }
      // Too late to set the site up: an account exists after all (someone
      // got there first, or this address has one). The form is asked for
      // again rather than assumed, and says why it changed.
      const refusal = mode === 'register' ? registerRefusal(err) : null;
      if (refusal) {
        setPassword('');
        setNotice(refusal);
        await loadForm();
        return;
      }
      // A sign-in that failed keeps the address and starts the password
      // again: what was typed was wrong, and is not left on screen to be
      // sent a second time.
      if (mode === 'login') setPassword('');
      triggerError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const isDark = theme === 'dark';
  const muted  = isDark ? '#4e4e62' : '#9399b0';

  const orbOpacity = isDark ? [0.14, 0.11, 0.09] : [0.28, 0.22, 0.16];

  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', overflow: 'hidden', background: isDark ? '#09090f' : '#f0f0fb' }}>

      {/* Animated background orbs (still for anyone who asks for less motion: globals.css) */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div className="login-orb" style={{
          position: 'absolute', width: 650, height: 650, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(99,102,241,${orbOpacity[0]}) 0%, transparent 70%)`,
          top: '-180px', left: '-120px',
          animation: 'float1 10s ease-in-out infinite',
        }} />
        <div className="login-orb" style={{
          position: 'absolute', width: 550, height: 550, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(139,92,246,${orbOpacity[1]}) 0%, transparent 70%)`,
          bottom: '-120px', right: '-100px',
          animation: 'float2 13s ease-in-out infinite',
        }} />
        <div className="login-orb" style={{
          position: 'absolute', width: 380, height: 380, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(59,130,246,${orbOpacity[2]}) 0%, transparent 70%)`,
          top: '38%', right: '28%',
          animation: 'float3 8s ease-in-out infinite',
        }} />
        {/* Extra orb for depth in light mode */}
        {!isDark && (
          <div className="login-orb" style={{
            position: 'absolute', width: 300, height: 300, borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(236,72,153,0.1) 0%, transparent 70%)',
            top: '15%', right: '10%',
            animation: 'float1 15s ease-in-out infinite reverse',
          }} />
        )}

        {/* Grid pattern */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: isDark
            ? 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)'
            : 'linear-gradient(rgba(99,102,241,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.07) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }} />
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggle}
        style={{
          position:       'fixed', top: 20, right: 20, zIndex: 10,
          width:          40, height: 40,
          borderRadius:   '50%',
          border:         `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(99,102,241,0.2)'}`,
          background:     isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.9)',
          backdropFilter: 'blur(8px)',
          cursor:         'pointer', fontSize: 16,
          display:        'flex', alignItems: 'center', justifyContent: 'center',
          color:          isDark ? '#eeeef5' : '#6366f1',
          transition:     'all 0.2s ease',
          boxShadow:      isDark ? '0 2px 8px rgba(0,0,0,0.25)' : '0 2px 10px rgba(99,102,241,0.2)',
        }}
        title={`Switch to ${isDark ? 'light' : 'dark'} theme`}
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
      >
        {isDark ? '☀' : '◑'}
      </button>

      {/* Center card */}
      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 16px',
      }}>
        <div style={{
          width: '100%', maxWidth: 420,
          animation: 'scaleIn 0.4s cubic-bezier(0.4,0,0.2,1)',
        }}>

          {/* Brand */}
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{
              width:          52, height: 52, borderRadius: 16,
              background:     'var(--accent-gradient)',
              margin:         '0 auto 16px',
              display:        'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow:      '0 8px 28px rgba(99,102,241,0.45)',
              fontSize:       24,
              animation:      'fadeUp 0.5s ease 0.1s both',
            }}>
              ⚡
            </div>
            <h1 style={{
              fontSize:      26, fontWeight: 800, letterSpacing: '-0.6px',
              color:         isDark ? '#eeeef5' : '#0d0e14',
              marginBottom:  6,
              animation:     'fadeUp 0.4s ease 0.15s both',
            }}>
              Financial Automation
            </h1>
            <p style={{
              fontSize:  14, color: muted, lineHeight: 1.5,
              animation: 'fadeUp 0.4s ease 0.2s both',
            }}>
              {firstRun
                ? 'Set up your admin account to get started'
                : form === FORM_CHECKING || form === FORM_UNREACHABLE
                  ? ' '
                  : 'Welcome back — sign in to continue'}
            </p>
          </div>

          {/* Card — shake applied here on error (not for anyone who asks
              for less motion: globals.css) */}
          <div className="login-card" style={{
            background:     isDark ? 'rgba(19,19,26,0.88)' : 'rgba(255,255,255,0.92)',
            backdropFilter: 'blur(24px)',
            border:         `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(99,102,241,0.14)'}`,
            borderRadius:   20,
            padding:        '30px 28px',
            boxShadow:      isDark
              ? '0 24px 64px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)'
              : '0 24px 64px rgba(99,102,241,0.15), 0 4px 16px rgba(0,0,0,0.06)',
            animation:      shaking ? 'shake 0.55s ease' : undefined,
          }}>

            <div style={{ fontSize: 15, fontWeight: 700, color: isDark ? '#eeeef5' : '#0d0e14', marginBottom: 18 }}>
              {firstRun ? 'Set up your admin account' : 'Sign in'}
            </div>

            {/* No form until the server has said which: a first run that
                flashed the sign-in form, or a failed check that left it there
                on a site with no account yet, both misled. */}
            {form === FORM_CHECKING ? (
              <p role="status" style={{ fontSize: 13.5, color: muted, textAlign: 'center', padding: '18px 0' }}>
                Loading…
              </p>
            ) : form === FORM_UNREACHABLE ? (
              <>
                <div className="alert alert-error" role="alert">
                  <span className="alert-icon">✕</span>
                  {STATUS_FAILED_MESSAGE}
                </div>
                <button type="button" className="btn btn-outline" onClick={retryForm} style={{ width: '100%' }}>
                  Retry
                </button>
              </>
            ) : (
              <>
                {/* Alerts. The lock replaces any earlier error: it is the one thing
                    to know until it ends. */}
                {lock && locked ? (
                  <div className="alert alert-warning" role="alert">
                    <span className="alert-icon">⚠</span>
                    {lock.text}
                  </div>
                ) : error && (
                  <div className="alert alert-error" role="alert">
                    <span className="alert-icon">✕</span>
                    {error}
                  </div>
                )}
                {notice && !error && !(lock && locked) && (
                  <div className="alert alert-info" role="status" style={{ marginBottom: 20 }}>
                    <span className="alert-icon">ℹ</span>
                    {notice}
                  </div>
                )}
                {firstRun && !error && (
                  <div className="alert alert-info" style={{ marginBottom: 20 }}>
                    <span className="alert-icon">ℹ</span>
                    First account becomes admin automatically.
                  </div>
                )}

                <form onSubmit={handleSubmit}>
                  <div className="form-group" style={{ animation: 'fadeUp 0.3s ease 0ms both' }}>
                    <label htmlFor="login-email" className="form-label">Email address</label>
                    <div className="input-wrapper">
                      <input id="login-email"
                        type="email"
                        className="form-input has-icon"
                        placeholder="you@company.com"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        autoFocus
                        // Lets a password manager fill this in, and offer to save
                        // the pair when an account is created: "username" is the
                        // value they pair with a password, an email address or not.
                        autoComplete="username"
                        inputMode="email"
                        // An address is not a word: no red underline, and no
                        // phone keyboard capitalising or "correcting" it.
                        spellCheck={false}
                        autoCapitalize="none"
                        autoCorrect="off"
                      />
                      <span className="input-icon" style={{ left: 12, top: '50%', transform: 'translateY(-50%)', position: 'absolute', color: 'var(--text-muted)', fontSize: 15 }}>✉</span>
                    </div>
                  </div>

                  <div className="form-group" style={{ marginBottom: 22, animation: 'fadeUp 0.3s ease 60ms both' }}>
                    <label htmlFor="login-password" className="form-label">Password</label>
                    <div className="input-wrapper" style={{ position: 'relative' }}>
                      <input id="login-password"
                        type={showPass ? 'text' : 'password'}
                        className="form-input has-icon"
                        placeholder={mode === 'register' ? passwordHint() : 'Enter your password'}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        minLength={mode === 'register' ? PASSWORD_MIN_LENGTH : 1}
                        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                        style={{ paddingRight: 42 }}
                      />
                      <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: 15 }}>🔒</span>
                      <button
                        type="button"
                        onClick={() => setShowPass(v => !v)}
                        style={{
                          position:  'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                          background: 'none', border: 'none', cursor: 'pointer',
                          color:     'var(--text-muted)', fontSize: 14, padding: 2,
                          transition: 'color 0.15s',
                        }}
                        title={showPass ? 'Hide password' : 'Show password'}
                        aria-label={showPass ? 'Hide password' : 'Show password'}
                        aria-pressed={showPass}
                      >
                        {showPass ? '🙈' : '👁'}
                      </button>
                    </div>
                    {mode === 'register' && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>
                        {passwordHint()}. Not your email address, and not one of the passwords everyone tries first.
                      </div>
                    )}
                  </div>

                  <div style={{ animation: 'fadeUp 0.3s ease 110ms both' }}>
                    <button
                      type="submit"
                      disabled={loading || locked}
                      style={{
                        width:       '100%', padding: '12px 0',
                        background:  'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                        color:       '#fff', border: 'none', borderRadius: 10,
                        fontSize:    15, fontWeight: 700, cursor: loading || locked ? 'not-allowed' : 'pointer',
                        display:     'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                        opacity:     loading || locked ? 0.7 : 1,
                        boxShadow:   '0 4px 18px rgba(99,102,241,0.45)',
                        transition:  'all 0.2s ease',
                      }}
                      onMouseEnter={e => { if (!loading && !locked) { e.currentTarget.style.boxShadow = '0 6px 26px rgba(99,102,241,0.58)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                      onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 4px 18px rgba(99,102,241,0.45)'; e.currentTarget.style.transform = 'none'; }}
                    >
                      {loading && <span className="btn-spinner" />}
                      {loading
                        ? 'Please wait...'
                        : locked
                          ? `Locked · ${countdown.text}`
                          : mode === 'login' ? 'Sign in' : 'Create account'}
                    </button>
                  </div>
                </form>

                {/* After first run there is nowhere to register: accounts and
                    password resets both come from an administrator, and the form
                    says so rather than leaving someone to look for a button. */}
                {!firstRun && (
                  <div style={{ marginTop: 18, textAlign: 'center', fontSize: 12.5, lineHeight: 1.55 }}>
                    <button
                      type="button"
                      onClick={() => setForgot(v => !v)}
                      aria-expanded={forgot}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}
                    >
                      Forgot your password?
                    </button>
                    {forgot && (
                      <p style={{ marginTop: 6, color: isDark ? 'rgba(255,255,255,0.6)' : '#4b5068', animation: 'fadeIn 0.2s ease' }}>
                        Ask your administrator to reset it from Users. You&apos;ll get a temporary password to sign in with, then set your own.
                      </p>
                    )}
                    <p style={{ marginTop: 8, color: muted }}>Need an account? Ask your administrator.</p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer note. What happens to a document, plainly: it used to say
              that no data was shared externally, and every document is read
              by Google Gemini and posted to Xero. */}
          <p style={{
            textAlign:  'center', marginTop: 20, fontSize: 12,
            color:      muted,
            animation:  'fadeIn 0.5s ease 0.4s both',
          }}>
            Invite-only · Documents are read by Google Gemini and posted to your Xero
          </p>
        </div>
      </div>
    </div>
  );
}
