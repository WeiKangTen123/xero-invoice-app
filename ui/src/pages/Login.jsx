import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { api } from '../api/client';

export default function Login() {
  const { login, register } = useAuth();
  const { theme, toggle }   = useTheme();
  const navigate = useNavigate();

  const [mode, setMode]       = useState('login');
  const [firstRun, setFirstRun] = useState(false);
  const [email, setEmail]     = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [tabKey, setTabKey]   = useState(0);
  const [slideDir, setSlideDir] = useState('right');

  const shakeTimer = useRef(null);

  useEffect(() => {
    api.get('/auth/status')
      .then(d => { if (!d.hasUsers) { setFirstRun(true); setMode('register'); } })
      .catch(() => {});
    return () => clearTimeout(shakeTimer.current);
  }, []);

  function triggerError(msg) {
    setError(msg);
    setShaking(true);
    clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShaking(false), 600);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') await login(email, password);
      else                  await register(email, password);
      navigate('/dashboard');
    } catch (err) {
      triggerError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function switchMode(m) {
    if (m === mode) return;
    setSlideDir(m === 'register' ? 'left' : 'right');
    setMode(m);
    setTabKey(k => k + 1);
    setError('');
    setEmail('');
    setPassword('');
    setShowPass(false);
  }

  const isDark = theme === 'dark';

  const orbOpacity = isDark ? [0.14, 0.11, 0.09] : [0.28, 0.22, 0.16];

  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', overflow: 'hidden', background: isDark ? '#09090f' : '#f0f0fb' }}>

      {/* Animated background orbs */}
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute', width: 650, height: 650, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(99,102,241,${orbOpacity[0]}) 0%, transparent 70%)`,
          top: '-180px', left: '-120px',
          animation: 'float1 10s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 550, height: 550, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(139,92,246,${orbOpacity[1]}) 0%, transparent 70%)`,
          bottom: '-120px', right: '-100px',
          animation: 'float2 13s ease-in-out infinite',
        }} />
        <div style={{
          position: 'absolute', width: 380, height: 380, borderRadius: '50%',
          background: `radial-gradient(circle, rgba(59,130,246,${orbOpacity[2]}) 0%, transparent 70%)`,
          top: '38%', right: '28%',
          animation: 'float3 8s ease-in-out infinite',
        }} />
        {/* Extra orb for depth in light mode */}
        {!isDark && (
          <div style={{
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
      >
        {isDark ? '☀' : '◑'}
      </button>

      {/* Center card */}
      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 20px',
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
              Xero Automation
            </h1>
            <p style={{
              fontSize:  14, color: isDark ? '#4e4e62' : '#9399b0', lineHeight: 1.5,
              animation: 'fadeUp 0.4s ease 0.2s both',
            }}>
              {firstRun
                ? 'Set up your admin account to get started'
                : mode === 'login'
                  ? 'Welcome back — sign in to continue'
                  : 'Create a new account'}
            </p>
          </div>

          {/* Card — shake applied here on error */}
          <div style={{
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

            {/* Tab switcher */}
            {!firstRun && (
              <div style={{
                display:      'flex', gap: 4,
                background:   isDark ? 'rgba(255,255,255,0.05)' : 'rgba(99,102,241,0.06)',
                borderRadius: 10, padding: 4, marginBottom: 24,
              }}>
                {['login', 'register'].map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => switchMode(m)}
                    style={{
                      flex:         1, padding: '8px 0', fontSize: 13, fontWeight: 600,
                      borderRadius: 7, border: 'none', cursor: 'pointer',
                      transition:   'all 0.2s ease',
                      background:   mode === m
                        ? isDark ? '#222230' : '#ffffff'
                        : 'transparent',
                      color: mode === m
                        ? isDark ? '#eeeef5' : '#6366f1'
                        : isDark ? '#4e4e62' : '#9399b0',
                      boxShadow: mode === m
                        ? isDark
                          ? '0 2px 8px rgba(0,0,0,0.3)'
                          : '0 2px 10px rgba(99,102,241,0.15)'
                        : 'none',
                    }}
                  >
                    {m === 'login' ? 'Sign in' : 'Register'}
                  </button>
                ))}
              </div>
            )}

            {/* Alerts */}
            {error && (
              <div className="alert alert-error">
                <span className="alert-icon">✕</span>
                {error}
              </div>
            )}
            {firstRun && !error && (
              <div className="alert alert-info" style={{ marginBottom: 20 }}>
                <span className="alert-icon">ℹ</span>
                First account becomes admin automatically.
              </div>
            )}

            {/* Form — re-mounts with slide animation on tab switch */}
            <form
              key={tabKey}
              onSubmit={handleSubmit}
              style={{
                animation: tabKey > 0
                  ? `${slideDir === 'left' ? 'slideFromRight' : 'slideFromLeft'} 0.22s ease`
                  : undefined,
              }}
            >
              <div className="form-group" style={{ animation: 'fadeUp 0.3s ease 0ms both' }}>
                <label className="form-label">Email address</label>
                <div className="input-wrapper">
                  <input
                    type="email"
                    className="form-input has-icon"
                    placeholder="you@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                  <span className="input-icon" style={{ left: 12, top: '50%', transform: 'translateY(-50%)', position: 'absolute', color: 'var(--text-muted)', fontSize: 15 }}>✉</span>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 22, animation: 'fadeUp 0.3s ease 60ms both' }}>
                <label className="form-label">Password</label>
                <div className="input-wrapper" style={{ position: 'relative' }}>
                  <input
                    type={showPass ? 'text' : 'password'}
                    className="form-input has-icon"
                    placeholder={mode === 'register' ? 'Min. 6 characters' : 'Enter your password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                    minLength={mode === 'register' ? 6 : 1}
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
                  >
                    {showPass ? '🙈' : '👁'}
                  </button>
                </div>
              </div>

              <div style={{ animation: 'fadeUp 0.3s ease 110ms both' }}>
                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width:       '100%', padding: '12px 0',
                    background:  'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                    color:       '#fff', border: 'none', borderRadius: 10,
                    fontSize:    15, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
                    display:     'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                    opacity:     loading ? 0.7 : 1,
                    boxShadow:   '0 4px 18px rgba(99,102,241,0.45)',
                    transition:  'all 0.2s ease',
                  }}
                  onMouseEnter={e => { if (!loading) { e.currentTarget.style.boxShadow = '0 6px 26px rgba(99,102,241,0.58)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
                  onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 4px 18px rgba(99,102,241,0.45)'; e.currentTarget.style.transform = 'none'; }}
                >
                  {loading && <span className="btn-spinner" />}
                  {loading
                    ? 'Please wait...'
                    : mode === 'login' ? 'Sign in' : 'Create account'}
                </button>
              </div>
            </form>
          </div>

          {/* Footer note */}
          <p style={{
            textAlign:  'center', marginTop: 20, fontSize: 12,
            color:      isDark ? '#4e4e62' : '#9399b0',
            animation:  'fadeIn 0.5s ease 0.4s both',
          }}>
            Secure · JWT authenticated · No data shared externally
          </p>
        </div>
      </div>
    </div>
  );
}
