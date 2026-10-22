import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { checklistView, showChecklist, progressText, CHECKLIST_TITLE, CHECKLIST_HINT } from './setup-checklist';

// "Get set up": AI reading, Mailbox, Xero and Watcher, in the setup guide's
// order, each ticked once it works (components/setup-checklist.js; the server
// judges each step). On Setup and on the Dashboard while Xero is not
// connected; gone once all four are done, and draws nothing until it has an
// answer or when it could not get one (it is a guide, and the page around it
// says what is wrong).
//
// Read again whenever the window comes back into focus (a test run or a
// watcher started in another tab) and whenever `refreshKey` changes: Setup
// bumps it after a save, a Test, a key added or removed and a Xero change.
export default function SetupChecklist({ refreshKey = 0, style }) {
  const [checklist, setChecklist] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/onboarding');
      setChecklist(d.checklist || null);
    } catch (_) {
      // The last answer stands; with none, nothing is drawn.
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  const view = checklistView(checklist);
  if (!showChecklist(view)) return null;

  return (
    <div className="card" style={{ marginBottom: 16, ...style }} aria-label={CHECKLIST_TITLE}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div className="card-title">{CHECKLIST_TITLE}</div>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{progressText(view)}</span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={view.total} aria-valuenow={view.doneCount} aria-label={`${progressText(view)} done`}
           style={{ height: 6, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden', marginBottom: 14 }}>
        <div style={{ height: '100%', width: `${view.percent}%`, background: 'var(--success)', borderRadius: 3, transition: 'width 0.4s ease' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {view.rows.map((row, i) => (
          <div key={row.key} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)', fontSize: 13,
          }}>
            <span role="img" aria-label={row.done ? 'Done' : 'Not done yet'}
                  style={{ width: 18, textAlign: 'center', fontWeight: 700, color: row.done ? 'var(--success)' : 'var(--text-muted)' }}>
              {row.done ? '✓' : '○'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                {i + 1}. {row.label}
              </div>
              {row.detail && (
                <div title={row.detail} style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.detail}
                </div>
              )}
            </div>
            {!row.done && (
              <Link to={row.to} className="btn btn-outline btn-sm" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{row.action}</Link>
            )}
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>{CHECKLIST_HINT}</div>
    </div>
  );
}
