import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useVisiblePolling } from '../../utils/useVisiblePolling';
import { bannerTitle, bannerDetail } from '../../pages/xero-insights/live';

// A Xero connection that has stopped working, said on every page rather than
// only in Setup. A revoked or expired connection used to surface one failed
// send at a time, on whichever document happened to be sent next; a
// connection made before attachments were asked for posts every bill without
// its PDF, which nothing on screen mentioned at all; and one made before the
// journals were asked for leaves the Dashboard unable to see when Xero
// changes, so its figures wait for a Refresh. One reconnect cures the last
// two, which is what the title says (see live.js#bannerTitle).
//
// Asked rarely: once on load, then every ten minutes while the tab is in view.
// The answer changes when someone reconnects, which happens in Setup, and Setup
// announces it (see 'xero-connection-changed') so the banner clears at once
// instead of ten minutes later.
const CHECK_EVERY_MS = 10 * 60 * 1000;
const DISMISSED_KEY = 'xeroBannerDismissed';

// What to say, and a key naming the problem. Dismissing hides that problem for
// the rest of the session; a different one (a further scope gone, a new reason)
// has a different key and shows again.
function problemOf(c) {
  if (!c) return null;
  const missing = Array.isArray(c.missingScopes) ? c.missingScopes : [];
  if (c.needsReconnect) {
    return { key: `reconnect:${c.reason || ''}`, title: 'Reconnect Xero in Setup',
             detail: c.reason || 'Xero is no longer accepting this connection, so nothing can be sent until it is reconnected.' };
  }
  const scoped = bannerTitle(missing);
  if (scoped) {
    return { key: `scopes:${[...missing].sort().join(',')}`, title: scoped, detail: c.reason || bannerDetail(missing) };
  }
  if (missing.length) {
    return { key: `scopes:${[...missing].sort().join(',')}`, title: 'Reconnect Xero in Setup',
             detail: c.reason || `Xero has not granted: ${missing.join(', ')}.` };
  }
  return null;
}

function readDismissed() {
  try { return sessionStorage.getItem(DISMISSED_KEY) || ''; } catch (_) { return ''; }
}

export default function XeroConnectionBanner({ isMobile }) {
  const [connection, setConnection] = useState(null);
  const [dismissed,  setDismissed]  = useState(readDismissed);
  const lastChecked = useRef(0);

  // The poller also calls this when the tab comes back into view; without the
  // age check, flicking between tabs would ask every time.
  const check = useCallback(async ({ force = false } = {}) => {
    if (!force && Date.now() - lastChecked.current < CHECK_EVERY_MS - 1000) return;
    lastChecked.current = Date.now();
    try {
      setConnection(await api.get('/xero/connection'));
    } catch (_) {
      // A failed check is not news about Xero: the last answer stands.
    }
  }, []);

  useEffect(() => { check({ force: true }); }, [check]);
  useVisiblePolling(check, CHECK_EVERY_MS);
  useEffect(() => {
    const onChanged = () => check({ force: true });
    window.addEventListener('xero-connection-changed', onChanged);
    return () => window.removeEventListener('xero-connection-changed', onChanged);
  }, [check]);

  const problem = problemOf(connection);
  if (!problem || problem.key === dismissed) return null;

  function dismiss() {
    setDismissed(problem.key);
    try { sessionStorage.setItem(DISMISSED_KEY, problem.key); } catch (_) { /* hidden until reload, then */ }
  }

  return (
    <div className="alert alert-warning" role="status" style={{
      alignItems: 'center', flexShrink: 0, flexWrap: 'wrap',
      margin: isMobile ? '10px 14px 0' : '14px 32px 0', marginBottom: 0,
    }}>
      <span className="alert-icon">⚠</span>
      <span style={{ flex: '1 1 240px', minWidth: 0 }}>
        <strong>{problem.title}</strong>
        {problem.detail && <> — {problem.detail}</>}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <Link to="/setup" className="btn btn-outline btn-sm">Open Setup</Link>
        <button type="button" onClick={dismiss} aria-label="Dismiss this warning for this session"
                title="Hide for the rest of this session"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 14, padding: '4px 6px' }}>
          ✕
        </button>
      </span>
    </div>
  );
}
