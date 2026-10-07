import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);
  // Set when the session could not be checked at all — the server down, a
  // deploy mid-restart, the laptop offline — as opposed to checked and refused.
  const [authError, setAuthError] = useState('');
  const [checking,  setChecking]  = useState(false);

  // Only a 401 means the token is no good. Every failure used to sign the user
  // out, so a 502 during a deploy or a moment without wifi threw away a valid
  // session and sent them to the login form. Now anything else keeps the token
  // and the app offers to try again (see SessionRetry in App.jsx).
  const checkSession = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) { setUser(null); setAuthError(''); setLoading(false); return; }
    setChecking(true);
    try {
      const d = await api.get('/auth/me');
      setUser(d.user);
      setAuthError('');
    } catch (err) {
      if (err.status === 401) {
        // Only the token this check sent is condemned. One stored since, by a
        // sign-in in another tab, is left for its own requests to judge.
        if (localStorage.getItem('token') === token) localStorage.removeItem('token');
        setUser(null);
        setAuthError('');
      } else {
        setAuthError(err.message || 'Could not reach the server');
      }
    } finally {
      setChecking(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  // Re-fetches /auth/me without a full page reload — used after Setup saves a
  // preference (like timezone) that other already-mounted components read off
  // the user object, so the change is reflected immediately everywhere.
  async function refreshUser() {
    if (!localStorage.getItem('token')) return;
    try { setUser((await api.get('/auth/me')).user); } catch { /* ignore */ }
  }

  async function login(email, password) {
    const data = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    setAuthError('');
    return data.user;
  }

  // Tell the server first, so it can stop this account's mailbox watcher —
  // otherwise it keeps polling for someone who has signed out. Best-effort: a
  // failed request must never trap the user in a session they asked to leave.
  async function logout() {
    try { await api.post('/auth/logout', {}); } catch (_) { /* leaving anyway */ }
    localStorage.removeItem('token');
    setUser(null);
    setAuthError('');
  }

  // The server signs this account's other sessions out and hands back a fresh
  // token for this one; storing it is what keeps the user signed in here.
  async function changePassword(currentPassword, newPassword) {
    const data = await api.post('/auth/change-password', { currentPassword, newPassword });
    if (data.token) localStorage.setItem('token', data.token);
  }

  async function register(email, password) {
    await api.post('/auth/register', { email, password });
    // Register doesn't return a token — immediately log in
    const data = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    setAuthError('');
    return data.user;
  }

  return (
    <AuthContext.Provider value={{ user, loading, authError, checking, retrySession: checkSession, login, logout, register, refreshUser, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
