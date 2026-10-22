import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api/client';
import RetryAlert from '../../components/RetryAlert';
import { useViewMode } from '../../context/ViewModeContext';
import {
  statusLine, signInRow, whereLabel, sessionRow, sessionsHeading, sessionsNote,
  watcherLine, mailboxLine, xeroLine, documentsLine, queueLine, storageLine,
  activityRow, panelActions, attributionOf, shortDateTime, relativeTime, SELF_NOTE,
} from './user-detail';

// ── Admin › Users › one account ───────────────────────────────────────────────
// A window in the middle of the page, two columns wide (a full-screen sheet
// with tabs on a phone), with everything an admin asks about an account in
// one place: its state, where it is signed
// in, its recent sign-ins, its mailbox, Xero and documents, what happened to
// it, and every control the Users page has. The wording is in user-detail.js
// (main/scripts/user-detail-ui.test.js runs it). The controls are the page's
// own handlers, passed in as `actions`: one implementation, so a confirm, a
// route or a toast cannot drift between two places. After any of them the
// page bumps `refreshKey` and this asks the server again.

const TONE = {
  green:  'var(--success)',
  red:    'var(--danger)',
  yellow: 'var(--warning)',
  blue:   'var(--info)',
  gray:   'var(--text-muted)',
};
const tone = t => TONE[t] || 'var(--text-muted)';
const MUTED = 'var(--text-muted)';
const SIGN_INS_SHOWN = 15;
const TITLE_ID = 'user-detail-title';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Section({ title, aside, children }) {
  return (
    <section style={{ padding: '14px 20px', borderTop: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, minHeight: 24 }}>
        <h3 style={{ margin: 0, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: MUTED }}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Quiet({ children }) {
  return <div style={{ fontSize: 12.5, color: MUTED }}>{children}</div>;
}

const ROW = { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0' };
const LIST = { listStyle: 'none', margin: 0, padding: 0 };
const NEW_TITLE = 'Not seen on this account before: a new device or place';
// The parts as tabs on a phone, where two columns do not fit.
const PHONE_TABS = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'signins',  label: 'Sign-ins' },
  { key: 'work',     label: 'Work' },
  { key: 'activity', label: 'Activity' },
];

export default function UserDetailPanel({ user, isMe = false, lastAdmin = false, timeZone, busy, error, refreshKey = 0, actions, onClose, onPrev = null, onNext = null }) {
  const { isMobile } = useViewMode();
  const panelRef = useRef(null);
  const [detail,   setDetail]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [loadErr,  setLoadErr]  = useState('');
  const [allSignIns, setAllSignIns] = useState(false);
  // On a phone one part shows at a time, chosen by tabs (PHONE_TABS).
  const [phoneTab, setPhoneTab] = useState('sessions');
  // One clock for every "ago" in the panel; read again on each load and
  // once a minute, so "2 min ago" does not stand still while it is open.
  const [now, setNow] = useState(() => Date.now());
  const latest = useRef(0);

  // The newest answer wins: an action's refetch can overtake the first load.
  const load = useCallback(async () => {
    const ask = ++latest.current;
    setLoading(true);
    try {
      const d = await api.get(`/admin/users/${user.id}/detail`);
      if (ask !== latest.current) return;
      setDetail(d);
      setLoadErr('');
      setNow(Date.now());
    } catch (err) {
      if (ask === latest.current) setLoadErr(err.message || 'Could not load this account');
    } finally {
      if (ask === latest.current) setLoading(false);
    }
  }, [user.id]);

  useEffect(() => { load(); }, [load, refreshKey]);
  // Prev and Next keep the window open on another account: start it fresh.
  useEffect(() => { setDetail(null); setAllSignIns(false); setPhoneTab('sessions'); }, [user.id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  // Escape closes the panel, unless a dialog opened from it (a confirm, the
  // reset or invite link) is on top: Escape is that dialog's. Listened for in
  // the capture phase, so this runs before the dialog's own listener closes
  // it and the check below still sees it. onClose is read from a ref so the
  // listener is added once.
  const closeRef = useRef(onClose);
  const stepRef  = useRef({ prev: onPrev, next: onNext });
  useEffect(() => { closeRef.current = onClose; stepRef.current = { prev: onPrev, next: onNext }; });
  useEffect(() => {
    function onKey(e) {
      // Left and right arrows move to the account before or after this one
      // in the list, unless a field has the keyboard or a dialog is open over
      // this one.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
        const over   = [...document.querySelectorAll('[aria-modal="true"]')].some(el => el !== panelRef.current);
        const step   = e.key === 'ArrowLeft' ? stepRef.current.prev : stepRef.current.next;
        if (!typing && !over && step) { e.preventDefault(); step(); }
        return;
      }
      if (e.key !== 'Escape') return;
      const above = [...document.querySelectorAll('[aria-modal="true"]')].some(el => el !== panelRef.current);
      if (above) return;
      closeRef.current?.();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Focus moves into the panel when it opens and back to the row that
  // opened it when it closes (the row is still there unless it was deleted).
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  // Tab stays inside the panel while it is open, as in any modal dialog.
  function trapTab(e) {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panelRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  }

  // The detail's own view of the account once it has come, over the row's.
  const acct     = { ...user, ...(detail?.user || {}) };
  const opts     = { timeZone, now };
  const status   = statusLine(acct, now, { timeZone });
  const sessions = Array.isArray(detail?.sessions) ? detail.sessions : [];
  const signIns  = Array.isArray(detail?.signIns)  ? detail.signIns  : [];
  const activity = Array.isArray(detail?.activity) ? detail.activity : [];
  const work     = detail?.work || null;
  const groups   = panelActions({ user: acct, isMe, lastAdmin, now, work });
  const credit   = attributionOf(detail);
  const inFlight = key => busy === `${key}:${user.id}`;

  // Each control is the page's handler, called with the account as the
  // page's list holds it (what the handlers have always been given).
  const run = {
    unlock:        () => actions.unlock(user),
    role:          () => actions.role(user),
    reset:         () => actions.reset(user),
    invite:        () => actions.invite(user),
    revokeInvite:  () => actions.revokeInvite(user),
    stopWatcher:   () => actions.stopWatcher(user),
    autoSubmitOff: () => actions.autoSubmitOff(user),
    disabled:      () => actions.disabled(user),
    delete:        () => actions.remove(user),
  };

  const shownSignIns = allSignIns ? signIns : signIns.slice(0, SIGN_INS_SHOWN);
  const note = sessionsNote(sessions, acct, now);

  // The four parts, laid out in two columns on the web and as tabs on a phone.
  const sessionsPart = (
    <Section
      title={sessionsHeading(sessions)}
      aside={!isMe && (
        <button type="button" className="btn btn-outline btn-sm" disabled={!!busy}
          title="Sign out everywhere: every device they are signed in on, listed here or not"
          onClick={() => actions.signOut(user)}>
          {inFlight('signout') ? '…' : '⇥ Revoke all'}
        </button>
      )}
    >
      {sessions.length === 0 ? (
        <>
          <Quiet>No active sessions</Quiet>
          {note && <div style={{ fontSize: 11.5, color: MUTED, marginTop: 4, fontStyle: 'italic' }}>{note}</div>}
        </>
      ) : (
        <ul style={LIST}>
          {sessions.map((s, i) => {
            const r = sessionRow(s, now, { timeZone });
            return (
              <li key={s.sid || i} style={{ ...ROW, borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 8px', fontSize: 13 }}>
                    <span style={{ fontWeight: 600 }}>{r.device}</span>
                    {r.ip && <span style={{ fontFamily: 'monospace', fontSize: 11.5, color: MUTED }}>{r.ip}</span>}
                    {r.isNew && <span className="badge badge-gray" title={NEW_TITLE}>NEW</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>
                    {[r.location, r.when].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {r.current ? (
                  <span className="badge badge-blue" title="The session you are using now">This device</span>
                ) : r.canRevoke && (
                  <button type="button" className="btn btn-outline btn-sm" disabled={!!busy}
                    title="Sign this device out" onClick={() => actions.revokeSession(user, s)}>
                    {inFlight(`revoke:${s.sid}`) ? '…' : 'Revoke'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );

  const signInsPart = (
    <Section title="Sign-ins (last 30 days)">
      {signIns.length === 0 ? (
        <Quiet>No sign-ins in the last 30 days</Quiet>
      ) : (
        <>
          <ul style={LIST}>
            {shownSignIns.map((e, i) => {
              const r = signInRow(e);
              const where = whereLabel(e);
              const showIp = e.ip && (!isMobile || !where);
              return (
                <li key={`${e.at}-${i}`} style={{ ...ROW, padding: '6px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap', minWidth: 86, fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>
                    {shortDateTime(e.at, opts)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: tone(r.tone) }}>
                        <span aria-hidden="true">{r.icon}</span> {r.label}
                      </span>
                      {e.isNew && <span className="badge badge-gray" title={NEW_TITLE}>NEW</span>}
                    </div>
                    {(where || showIp) && (
                      <div title={e.ip || undefined}
                           style={{ fontSize: 11.5, color: MUTED, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {[where, showIp ? e.ip : ''].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {signIns.length > SIGN_INS_SHOWN && (
            <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 6 }} onClick={() => setAllSignIns(v => !v)}>
              {allSignIns ? 'Show fewer' : `Show all ${signIns.length}`}
            </button>
          )}
        </>
      )}
    </Section>
  );

  const workPart = work ? <WorkSection work={work} demo={acct.demo === true} role={acct.role} now={now} /> : null;

  const activityPart = (
    <Section title="Activity">
      {activity.length === 0 ? (
        <Quiet>Nothing recorded yet</Quiet>
      ) : (
        <ul style={LIST}>
          {activity.map((a, i) => {
            const r = activityRow(a);
            return (
              <li key={`${a.at}-${i}`} style={{ ...ROW, padding: '6px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize: 12, color: MUTED, whiteSpace: 'nowrap', minWidth: 86, fontVariantNumeric: 'tabular-nums', paddingTop: 1 }}>
                  {shortDateTime(a.at, opts)}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: r.muted ? MUTED : 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                  {r.text}{r.by ? ` · ${r.by}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );

  const PARTS = { sessions: sessionsPart, signins: signInsPart, work: workPart, activity: activityPart };
  const column = { minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' };

  return (
    <>
      {/* The page behind is dimmed and a click on it closes the window. */}
      <div aria-hidden="true" onClick={onClose}
           style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.45)', animation: 'fadeIn 0.15s ease' }} />

      {/* Centres the window and lets clicks through to the backdrop around
          it. Over the chat launcher (200), so it needs no --fab-clearance
          (fab-clearance.test.js), and under the confirm and reset dialogs
          (Modal, 1000), which open over it. */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 301, pointerEvents: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: isMobile ? 0 : 16,
      }}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={TITLE_ID}
          tabIndex={-1}
          onKeyDown={trapTab}
          style={{
            pointerEvents: 'auto',
            width: isMobile ? '100vw' : 'min(960px, calc(100vw - 32px))',
            height: isMobile ? '100dvh' : 'auto',
            maxHeight: isMobile ? '100dvh' : '85vh',
            background: 'var(--bg-card)', outline: 'none',
            border: isMobile ? 'none' : '1px solid var(--border)',
            borderRadius: isMobile ? 0 : 'var(--radius-lg)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column', animation: 'scaleIn 0.18s ease',
            // A full-screen sheet on a phone starts below the notch.
            paddingTop: isMobile ? 'env(safe-area-inset-top, 0px)' : 0,
          }}
        >
          {/* Head: who, and what state the account is in, with the accounts
              before and after it in the list. Stays put while the parts
              scroll, with any error from a control under it. */}
          <div style={{ padding: '16px 20px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {(onPrev || onNext) && (
                <button type="button" className="btn btn-outline btn-sm" disabled={!onPrev} onClick={onPrev || undefined}
                        aria-label="Previous account" title="Previous account (left arrow)">‹{isMobile ? '' : ' Prev'}</button>
              )}
              <h2 id={TITLE_ID} style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 16, fontWeight: 700, overflowWrap: 'anywhere', textAlign: isMobile ? 'left' : 'center' }}>
                {user.email}
                {isMe && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>you</span>}
              </h2>
              {(onPrev || onNext) && (
                <button type="button" className="btn btn-outline btn-sm" disabled={!onNext} onClick={onNext || undefined}
                        aria-label="Next account" title="Next account (right arrow)">{isMobile ? '' : 'Next '}›</button>
              )}
              <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: MUTED, fontSize: 16, lineHeight: 1, padding: 4 }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: isMobile ? 'flex-start' : 'center', gap: 6, marginTop: 8, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: tone(status.state.tone), flexShrink: 0 }} />
              <span>{status.summary}</span>
              {status.badges.map(b => (
                <span key={b.key} className={`badge ${b.key === 'admin' ? 'badge-yellow' : 'badge-gray'}`} title={b.title}>{b.text}</span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 4, textAlign: isMobile ? 'left' : 'center', lineHeight: 1.5 }}>
              {status.seen}
              {status.notes.map((n, i) => (
                <span key={i}> · <span style={{ color: tone(n.tone) }}>{n.text}</span></span>
              ))}
            </div>

            {error && (
              <div className="alert alert-error" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
                <span className="alert-icon">✕</span>{error}
              </div>
            )}
          </div>

          {(loadErr || (!detail && loading)) && (
            <div style={{ flexShrink: 0 }}>
          {loadErr && (
            <div style={{ padding: '14px 20px 0' }}>
              <RetryAlert message={detail ? `Could not refresh this account. ${loadErr}` : `Could not load this account. ${loadErr}`}
                          onRetry={load} busy={loading} style={{ marginBottom: 0 }} />
            </div>
          )}

          {!detail && loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: MUTED, padding: '18px 20px', fontSize: 13 }}>
              <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
              Loading…
            </div>
          )}
            </div>
          )}

          {/* The parts: two columns, each scrolling on its own, on the web;
              one at a time under tabs on a phone. */}
          {detail && !isMobile && (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
              <div style={{ ...column, borderRight: '1px solid var(--border)' }}>
                {sessionsPart}
                {signInsPart}
              </div>
              <div style={column}>
                {workPart}
                {activityPart}
              </div>
            </div>
          )}
          {detail && isMobile && (
            <>
              <div role="tablist" aria-label="Parts of this account" style={{ display: 'flex', gap: 4, padding: '8px 12px 0', borderBottom: '1px solid var(--border)', flexShrink: 0, overflowX: 'auto' }}>
                {PHONE_TABS.map(t => (
                  <button key={t.key} type="button" role="tab" aria-selected={phoneTab === t.key} onClick={() => setPhoneTab(t.key)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer', padding: '8px 10px', fontSize: 13, whiteSpace: 'nowrap',
                      fontWeight: phoneTab === t.key ? 700 : 500,
                      color: phoneTab === t.key ? 'var(--accent)' : MUTED,
                      borderBottom: `2px solid ${phoneTab === t.key ? 'var(--accent)' : 'transparent'}`,
                    }}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" style={{ ...column, flex: 1 }}>
                {PARTS[phoneTab]}
              </div>
            </>
          )}

          {/* The controls, in groups, the ones that cannot be undone last.
              Always in view under the parts; shown while the detail loads,
              and if it fails: they work from the page's list. Automation
              waits for the detail, which is what says whether a watcher is
              running. */}
          <div style={{ flexShrink: 0, maxHeight: isMobile ? '40dvh' : undefined, overflowY: isMobile ? 'auto' : undefined }}>
          <Section title="Actions">
            {isMe && <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, lineHeight: 1.5 }}>{SELF_NOTE}</div>}
            {groups.map(g => (
              <div key={g.key} role="group" aria-label={g.label}
                   style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <span style={{ fontSize: 11.5, minWidth: 76, color: g.key === 'danger' ? 'var(--danger)' : MUTED }}>{g.label}</span>
                {g.actions.map(a => (
                  <button key={a.key} type="button"
                    className={a.danger ? 'btn btn-sm' : 'btn btn-outline btn-sm'}
                    disabled={!!busy || !!a.blocked}
                    title={a.blocked || a.title}
                    onClick={run[a.key]}
                    style={a.danger ? { background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.2)' } : undefined}>
                    {inFlight(a.busyKey) ? '…' : a.label}
                  </button>
                ))}
              </div>
            ))}
          </Section>
          </div>

          {/* The places come from DB-IP's free database; its CC BY licence
              asks for this link wherever they are shown. */}
          <div style={{
            flexShrink: 0, borderTop: '1px solid var(--border)', padding: '9px 20px',
            paddingBottom: isMobile ? 'calc(9px + var(--safe-bottom))' : 9,
            display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8, fontSize: 11, color: MUTED,
          }}>
            <a href={credit.url} target="_blank" rel="noopener noreferrer" style={{ color: MUTED }}>{credit.text}</a>
            <span>Locations are approximate</span>
          </div>
        </div>
      </div>
    </>
  );
}

// Plain lines: the watcher and auto-submit, the mailbox, Xero, the
// documents (only the counts that are not zero), the queue and the storage.
// The role tells an admin's chosen sample data from a demo account's.
function WorkSection({ work, demo, role, now }) {
  const watcher = watcherLine(work);
  const xero    = xeroLine(work.xero, { demo, role, now });
  const queue   = queueLine(work.queue);
  const storage = storageLine(work.storage, work.geminiKeys);
  const lastDoc = relativeTime(work.documents?.lastProcessedAt, now);
  const label   = { color: MUTED, fontSize: 12, paddingTop: 1 };
  const value   = { margin: 0, minWidth: 0, overflowWrap: 'anywhere' };
  return (
    <Section title="Work">
      <dl style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: '6px 10px', margin: 0, fontSize: 13 }}>
        <dt style={label}>Watcher</dt>
        <dd style={value}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: tone(watcher.tone), marginRight: 6, verticalAlign: 'middle' }} />
          {watcher.text}
        </dd>
        <dt style={label}>Mailbox</dt>
        <dd style={value}>{mailboxLine(work.mailbox)}</dd>
        <dt style={label}>Xero</dt>
        <dd style={{ ...value, color: xero.tone === 'yellow' ? tone('yellow') : undefined }}>{xero.text}</dd>
        <dt style={label}>Documents</dt>
        <dd style={value}>
          {documentsLine(work.documents)}
          {lastDoc && <span style={{ color: MUTED }}> · last {lastDoc}</span>}
        </dd>
        <dt style={label}>Queue</dt>
        <dd style={{ ...value, color: queue.tone ? tone(queue.tone) : undefined }} title={queue.title || undefined}>{queue.text}</dd>
        <dt style={label}>Storage</dt>
        <dd style={value} title={storage.title || undefined}>{storage.text}</dd>
      </dl>
    </Section>
  );
}
