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
  //
  // Only the token a check sent is condemned by its 401. One stored since, by
  // a sign-in in another tab, is checked in its turn: the API client does not
  // ask /auth/* twice itself (api/client.js), so it is asked here, once.
  const checkSession = useCallback(async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = localStorage.getItem('token');
        if (!token) { setUser(null); setAuthError(''); return; }
        setChecking(true);
        try {
          const d = await api.get('/auth/me');
          setUser(d.user);
          setAuthError('');
          return;
        } catch (err) {
          if (err.status !== 401) { setAuthError(err.message || 'Could not reach the server'); return; }
          const replaced = localStorage.getItem('token') !== token;
          if (replaced && attempt === 0) continue;
          if (!replaced) localStorage.removeItem('token');
          setUser(null);
          setAuthError('');
          return;
        }
      }
    } finally {
      // Once, after the last answer: the app waits on `loading` before it
      // decides between the sign-in page and the one asked for.
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

  // Every other session this account holds is signed out; this one is kept
  // the same way change-password keeps it, by storing the fresh token.
  async function signOutEverywhere() {
    const data = await api.post('/auth/sign-out-everywhere', {});
    if (data.token) localStorage.setItem('token', data.token);
  }

  // The account is made and signed in by the one request: its answer carries
  // the token and the user, as a sign-in's does. A second request to
  // /auth/login used to follow it, which spent one of the address's sign-in
  // attempts, left the session the registration started unused, and, if it
  // failed, left the form offering to create an account that already existed.
  async function register(email, password) {
    const data = await api.post('/auth/register', { email, password });
    localStorage.setItem('token', data.token);
    setUser(data.user);
    setAuthError('');
    return data.user;
  }

  return (
    <AuthContext.Provider value={{ user, loading, authError, checking, retrySession: checkSession, login, logout, register, refreshUser, changePassword, signOutEverywhere }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
