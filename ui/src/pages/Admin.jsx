import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import Modal from '../components/Modal';
import RetryAlert from '../components/RetryAlert';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useToast } from '../context/ToastContext';
import { formatDateTime, formatRelative, formatShortDate } from '../utils/formatDate';
import { fmtMoney } from '../utils/format';
import { staggerIn } from '../utils/stagger';
import ActivityPanel from './admin/ActivityPanel';
import UserDetailPanel from './admin/UserDetailPanel';
import LinkResult from './admin/LinkResult';
import { lockBadge, failedNote, mustSetNote, demoBadge, copyBoxes, copyDefaults, addUserPayload, addUserProblem, copiedNote, inviteNote, revokeInviteAsk } from './admin/users';

const ADMIN_TABS = [
  { key: 'users',      label: '👥 Users' },
  { key: 'reports',    label: '⚠ Reports' },
  { key: 'monitoring', label: '📊 Monitoring' },
  { key: 'logs',       label: '📄 Logs' },
  { key: 'activity',   label: '🕑 Activity' },
];

function Avatar({ email }) {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: 9, flexShrink: 0,
      background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 12, fontWeight: 700, color: '#fff',
    }}>
      {email?.slice(0, 2).toUpperCase()}
    </div>
  );
}

// A click focuses a focusable row too, and a ring there is only noise; the ring
// is for someone moving through the list with the keyboard. A browser too old
// to know :focus-visible throws on the selector, and gets the ring every time.
function keyboardFocused(el) {
  try { return el.matches(':focus-visible'); } catch (_) { return true; }
}

// Stop watcher and Turn off auto-submit, asked and sent the same way from
// Monitoring's table and from an account's detail panel on Users.
function stopWatcherAsk(u) {
  return { title: `Stop ${u.email}'s mailbox watcher?`, message: 'Their inbox stops being polled until they start it again from their Dashboard.', confirmLabel: 'Stop watcher' };
}
function stopWatcherSend(u) {
  return api.post(`/admin/users/${u.id}/watcher/stop`, {});
}
function autoSubmitOffAsk(u) {
  return { title: `Turn off auto-submit for ${u.email}?`, message: 'New invoices wait for manual review instead of posting to Xero. Only they can turn it back on.', confirmLabel: 'Turn off', danger: true };
}
function autoSubmitOffSend(u) {
  return api.patch(`/admin/users/${u.id}/auto-process`, { autoProcess: false });
}

// A button on a user's row. The row itself opens the account's panel, by
// click and by Enter or Space, so the button keeps both to itself.
function RowButton({ onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className="btn btn-outline btn-sm"
      onClick={e => { e.stopPropagation(); onClick(); }}
      onKeyDown={e => e.stopPropagation()}
      style={{ padding: '2px 9px', fontSize: 11.5 }}
      {...rest}
    >
      {children}
    </button>
  );
}

export default function Admin() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const toast   = useToast();
  const navigate     = useNavigate();
  // The open tab is in the address, so Back from a flagged invoice opened on
  // Reports returns to Reports rather than to Users, and a reload stays put.
  // Replaced rather than pushed: Back leaves the page instead of walking
  // through every tab clicked on the way.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = ADMIN_TABS.some(t => t.key === searchParams.get('tab')) ? searchParams.get('tab') : 'users';
  function setTab(key) {
    const next = new URLSearchParams(searchParams);
    if (key === 'users') next.delete('tab'); else next.set('tab', key);
    setSearchParams(next, { replace: true });
  }
  // Set when the admin clicks a user in Monitoring's per-user table to drill into
  // that user's logs — lifted up here (rather than living inside LogsPanel) so a
  // click from a different tab can both switch to Logs AND pre-filter it.
  const [logsUserId, setLogsUserId] = useState('');
  const [logsUserEmail, setLogsUserEmail] = useState('');

  function viewUserLogs(userId, email) {
    setLogsUserId(userId);
    setLogsUserEmail(email);
    setTab('logs');
  }
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);
  // A failed load said "No users found", which an admin could take literally.
  const [usersErr, setUsersErr] = useState('');
  const [email,   setEmail]   = useState('');
  const [role,    setRole]    = useState('user');
  // A demo account (pages/admin/users.js): sample data in place of a Xero
  // connection, with this admin's settings copied over so it works at once.
  // The copy boxes only show, and only count, once Demo account is ticked.
  const [demo,       setDemo]       = useState(false);
  const [copyFrom,   setCopyFrom]   = useState(() => copyDefaults());
  const [filterFrom, setFilterFrom] = useState('');
  const [error,   setError]   = useState('');
  // An invite on its way, and then what came of it: shown in the card in
  // place of the form until Done, as its link (when email is not set up) is
  // shown nowhere else and never again.
  const [inviting, setInviting] = useState(false);
  const [invited,  setInvited]  = useState(null);
  // Which account's detail panel is open, which control is in flight
  // (`key:id`), and the link a New link or Send reset link came back with
  // ({ kind, email, answer }), shown in a dialog. A control is used from the
  // panel, which covers the page, so its error is said in the panel
  // (actionError) and its success in a toast; the panel asks the server
  // again whenever detailRefresh moves.
  const [detailId,      setDetailId]      = useState(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [actionError,   setActionError]   = useState('');
  const [busy,       setBusy]       = useState(null);
  const [shownLink,  setShownLink]  = useState(null);

  async function fetchUsers() {
    try { const d = await api.get('/admin/users'); setUsers(d.users || []); setUsersErr(''); }
    catch (err) { setUsersErr(err.message || 'Could not load the users'); }
  }

  useEffect(() => {
    fetchUsers().finally(() => setLoading(false));
  }, []);

  // The Invite a user form as a whole, for the helpers that say what it sends
  // and why it cannot be sent yet (the mailbox copy needs a sender address).
  // No password: the person sets their own from the link.
  const form = { email, role, demo, copyFrom, mailboxFilterFrom: filterFrom };
  const createProblem = addUserProblem(form);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    if (createProblem) { setError(createProblem); return; }
    setInviting(true);
    try {
      // The result says what was copied, from the server's answer: a group
      // with nothing to copy is not copied, whatever its box said.
      const payload = addUserPayload(form);
      const created = await api.post('/admin/users', payload);
      setEmail(''); setRole('user');
      setDemo(false); setCopyFrom(copyDefaults()); setFilterFrom('');
      setInvited({ email: created.user?.email || payload.email, invite: created.invite || {}, copied: copiedNote(payload, created) });
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setInviting(false);
    }
  }

  // One request per control, then the list and the open panel are refetched
  // so both show the server's view rather than an optimistic guess. True when
  // the request went through, for a caller with something to say after it.
  // `done` is the toast, or a function making it from the server's answer.
  async function control(key, u, send, done) {
    setBusy(`${key}:${u.id}`); setActionError('');
    try {
      const answer = await send();
      if (done) toast.success(typeof done === 'function' ? done(answer || {}) : done);
      setDetailRefresh(n => n + 1);
      await fetchUsers();
      return true;
    } catch (err) {
      setActionError(err.message);
      // From a row (New link, Revoke), with no panel open on the account to
      // say it in.
      if (detailId !== u.id) toast.error(err.message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  function openDetail(id) { setActionError(''); setDetailId(id); }
  function closeDetail()  { setActionError(''); setDetailId(null); }

  // The lock ends on its own at lockedUntil; this ends it now, for the owner
  // who mistyped five times and is on the phone about it. The count of wrong
  // passwords goes too.
  async function handleUnlock(u) {
    if (await control('unlock', u, () => api.post(`/admin/users/${u.id}/unlock`, {}))) {
      toast.success(`${u.email} is unlocked. They can sign in again now.`);
    }
  }

  async function handleDelete(u) {
    if (!(await confirm({ title: `Delete ${u.email}?`, message: 'Their account, credentials and files are removed. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return;
    // The account's panel has nothing left to show.
    if (await control('delete', u, () => api.delete(`/admin/users/${u.id}`), `${u.email} deleted.`)) {
      setDetailId(id => (id === u.id ? null : id));
    }
  }

  async function handleRole(u) {
    const role = u.role === 'admin' ? 'user' : 'admin';
    // A demo account may still have the short password demo accounts were
    // once allowed, so the server makes it choose a new one first.
    const newPassword = role === 'admin' && u.demo === true;
    // An admin on sample data who has their own Xero goes back to it when
    // made a user, as a user cannot switch (routes/admin.js); the server
    // says whether that happened (switchedToXero).
    const onSample = role === 'user' && u.demo === true;
    const ok = await confirm(role === 'admin'
      ? { title: `Make ${u.email} an admin?`, message: `They will see every account, every flagged invoice and the server logs, and can do everything on this page.${newPassword ? ' As a demo account, it must choose a new password before anything else.' : ''}`, confirmLabel: 'Make admin' }
      : { title: `Remove admin from ${u.email}?`, message: `They keep their account and data, and lose access to this page.${onSample ? ' They are on sample data: if they have their own Xero connection, they are switched back to it, as a user cannot switch.' : ''}`, confirmLabel: 'Make user' });
    if (!ok) return;
    await control('role', u, () => api.patch(`/admin/users/${u.id}/role`, { role }),
      answer => `${u.email} is now ${role === 'admin' ? 'an admin' : 'a user'}.${newPassword ? ' They must choose a new password before anything else.' : ''}${answer.switchedToXero ? ' They are back on their own Xero.' : ''}`);
  }

  async function handleSignOut(u) {
    if (!(await confirm({ title: `Sign ${u.email} out everywhere?`, message: 'Every device they are signed in on is signed out. They can sign in again straight away.', confirmLabel: 'Sign out' }))) return;
    await control('signout', u, () => api.post(`/admin/users/${u.id}/sign-out`, {}), `${u.email} has been signed out everywhere.`);
  }

  async function handleDisabled(u) {
    const disabled = !u.disabledAt;
    if (disabled && !(await confirm({ title: `Disable ${u.email}?`, message: 'They cannot sign in and their mailbox watcher stops. Invoices, receipts and credentials are kept, and you can enable the account again at any time.', confirmLabel: 'Disable', danger: true }))) return;
    await control('disabled', u, () => api.patch(`/admin/users/${u.id}/disabled`, { disabled }), `${u.email} has been ${disabled ? 'disabled' : 'enabled'}.`);
  }

  async function handleStopWatcher(u) {
    if (!(await confirm(stopWatcherAsk(u)))) return;
    await control('watcher', u, () => stopWatcherSend(u), `${u.email}'s mailbox watcher has stopped.`);
  }

  async function handleAutoSubmitOff(u) {
    if (!(await confirm(autoSubmitOffAsk(u)))) return;
    await control('auto', u, () => autoSubmitOffSend(u), `Auto-submit is off for ${u.email}. New invoices wait for review.`);
  }

  // One session (one device) of an account, from its detail panel; the
  // others stay signed in. The server refuses the admin's own current
  // session: that is Sign out. In flight as `revoke:<sid>:<user id>`.
  async function handleRevokeSession(u, s) {
    const where = [s.device, s.location].filter(Boolean).join(' · ');
    if (!(await confirm({
      title: `Revoke this session of ${u.email}?`,
      message: `${where || 'This device'} is signed out. They can sign in again, and their other sessions stay signed in.`,
      confirmLabel: 'Revoke',
    }))) return;
    await control(`revoke:${s.sid}`, u, () => api.post(`/admin/users/${u.id}/sessions/${encodeURIComponent(s.sid)}/revoke`, {}), 'Session revoked.');
  }

  // A reset link for the account: emailed to them when this server can send
  // email, otherwise shown here once to pass on. An administrator never sets
  // or sees anyone's password. The answer is the dialog's to show.
  async function handleResetLink(u) {
    let answer = null;
    const sent = await control('reset', u, async () => {
      answer = await api.post(`/admin/users/${u.id}/reset-link`, {});
      return answer;
    });
    if (sent) setShownLink({ kind: 'reset', email: u.email, answer: answer?.reset || {} });
  }

  // Another invite link for an account that has not set its password yet,
  // shown as the first was: emailed, or to copy.
  async function handleNewInvite(u) {
    let answer = null;
    const sent = await control('invite', u, async () => {
      answer = await api.post(`/admin/users/${u.id}/invite`, {});
      return answer;
    });
    if (sent) setShownLink({ kind: 'invite', email: u.email, answer: answer?.invite || {} });
  }

  async function handleRevokeInvite(u) {
    if (!(await confirm(revokeInviteAsk(u)))) return;
    await control('revokeInvite', u, () => api.delete(`/admin/users/${u.id}/invite`), `The invite for ${u.email} was revoked.`);
  }

  // Every control the detail panel offers is one of the handlers above.
  const userActions = {
    unlock: handleUnlock, role: handleRole, reset: handleResetLink, signOut: handleSignOut,
    disabled: handleDisabled, remove: handleDelete, stopWatcher: handleStopWatcher,
    autoSubmitOff: handleAutoSubmitOff, revokeSession: handleRevokeSession,
    invite: handleNewInvite, revokeInvite: handleRevokeInvite,
  };

  // A disabled admin cannot sign in, so they do not count as the last one.
  const admins = users.filter(u => u.role === 'admin' && !u.disabledAt);
  // The server refuses these on the last admin too; the panel says why first.
  const isLastAdmin = u => u.role === 'admin' && !u.disabledAt && admins.length <= 1;
  // The open panel's account, as the list holds it; gone once it is deleted.
  const detailUser = detailId ? users.find(u => u.id === detailId) : null;
  // The accounts before and after it, in the list's order, for the window's
  // Prev and Next (and the arrow keys); null at either end.
  const detailIndex = detailUser ? users.indexOf(detailUser) : -1;
  const detailPrev  = detailIndex > 0 ? () => openDetail(users[detailIndex - 1].id) : null;
  const detailNext  = detailIndex >= 0 && detailIndex < users.length - 1 ? () => openDetail(users[detailIndex + 1].id) : null;
  // One reading of the clock for every row's lock badge; a refetch re-renders.
  const now = Date.now();

  return (
    <div>
      <div className="page-header">
        <h1>Admin</h1>
        <p>Manage users and review flagged invoice issues.</p>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Admin sections" style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, marginBottom: 20, width: 'fit-content', maxWidth: '100%', overflowX: 'auto' }}>
        {ADMIN_TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={{
            padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            background: tab === t.key ? 'var(--accent-gradient)' : 'transparent',
            color: tab === t.key ? '#fff' : 'var(--text-muted)',
            boxShadow: tab === t.key ? '0 2px 8px rgba(99,102,241,0.3)' : 'none',
            transition: 'all 0.18s ease',
          }}>{t.label}</button>
        ))}
      </div>

      {error   && <div className="alert alert-error"><span className="alert-icon">✕</span>{error}</div>}

      {tab === 'reports'    && <ReportsPanel navigate={navigate} timezone={me?.timezone} />}
      {tab === 'monitoring' && <MonitoringPanel timezone={me?.timezone} onViewLogs={viewUserLogs} />}
      {tab === 'logs'       && <LogsPanel timezone={me?.timezone} initialUserId={logsUserId} initialUserEmail={logsUserEmail} />}
      {tab === 'activity'   && <ActivityPanel timezone={me?.timezone} />}

      {/* The 320px side panel is a fixed track, so on a phone it took almost the
          whole viewport and left the users list with the remainder. Collapses to
          one column via .mobile-mode (see globals.css) rather than reading the
          view mode here. */}
      {tab === 'users' && <div className="admin-users-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'start' }}>

        {/* Users list */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div>
              <div className="card-title">Users</div>
              <div className="card-subtitle" style={{ marginBottom: 0 }}>{users.length} account{users.length !== 1 ? 's' : ''} total</div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={fetchUsers} aria-label="Refresh users" title="Refresh users">↻</button>
          </div>

          {usersErr && (
            <RetryAlert message={users.length ? `Could not refresh the list. ${usersErr}` : `Could not load the users. ${usersErr}`}
                        onRetry={fetchUsers} />
          )}

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '16px 0' }}>
              <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
              Loading...
            </div>
          ) : users.length === 0 ? (
            !usersErr && (
              <div className="empty-state">
                <div className="empty-state-icon">👥</div>
                <div>No users found</div>
              </div>
            )
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {users.map((u, i) => {
                const isMe      = u.id === me?.id;
                const open      = detailId === u.id;
                // Sign-in state (pages/admin/users.js): locked, with a badge (Unlock
                // is in the account's panel); wrong passwords since the last
                // sign-in; a temporary password still to be replaced.
                const lock    = lockBadge(u, now, { timeZone: me?.timezone });
                const failed  = failedNote(u, now);
                const mustSet = mustSetNote(u);
                const isDemo  = demoBadge(u);
                // Invited and no password yet: the invite in place of the
                // sign-in details, which it has none of (users.js inviteNote).
                const invite  = inviteNote(u, { now, day: formatShortDate(u.inviteExpiresAt, me?.timezone) });
                return (
                  <div key={u.id} style={{ animation: staggerIn(i, 40, '0.25s') }}>
                    {/* Clicking a row opens the account's detail panel
                        (admin/UserDetailPanel.jsx), with every control. Your own
                        row opens it too, to look: the controls the server refuses
                        on yourself are not offered there. Each row is a button to
                        the keyboard and to a screen reader as well, since the
                        controls cannot be reached any other way; the panel gives
                        focus back to the row when it closes. */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-haspopup="dialog"
                      onClick={() => openDetail(u.id)}
                      onKeyDown={e => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        // Space would otherwise scroll the page as well.
                        e.preventDefault();
                        openDetail(u.id);
                      }}
                      onFocus={e => { if (keyboardFocused(e.currentTarget)) e.currentTarget.style.outline = '2px solid var(--accent)'; }}
                      onBlur={e => { e.currentTarget.style.outline = ''; }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '11px 12px', borderRadius: 10,
                        background: isMe ? 'var(--accent-subtle)' : open ? 'var(--bg-hover)' : 'transparent',
                        border: isMe ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent',
                        cursor: 'pointer',
                        opacity: u.disabledAt ? 0.65 : 1,
                        transition: 'all 0.15s',
                        outlineOffset: -2,
                      }}
                      onMouseEnter={e => { if (!isMe) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={e => { if (!isMe && !open) e.currentTarget.style.background = 'transparent'; }}
                      title="Open the account's details"
                    >
                      <Avatar email={u.email} />

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                          <span style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.email}
                          </span>
                          {isMe && (
                            <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600 }}>you</span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                          <span className={`badge ${u.role === 'admin' ? 'badge-yellow' : 'badge-gray'}`}>
                            {u.role === 'admin' ? '★ ' : ''}{u.role}
                          </span>
                          {isDemo && (
                            <span className="badge badge-gray" title={isDemo.title}>{isDemo.text}</span>
                          )}
                          {u.disabledAt && (
                            <span className="badge badge-red" title={`Disabled ${formatDateTime(u.disabledAt, me?.timezone)}`}>⏸ Disabled</span>
                          )}
                          {invite ? (
                            <>
                              <span className={`badge ${invite.expired ? 'badge-red' : 'badge-yellow'}`} title={invite.title}>{invite.text}</span>
                              <RowButton onClick={() => handleNewInvite(u)} disabled={!!busy} title="Make a new invite link, emailed or to copy">
                                {busy === `invite:${u.id}` ? '…' : 'New link'}
                              </RowButton>
                              <RowButton onClick={() => handleRevokeInvite(u)} disabled={!!busy} title="Stop the link they were sent from working">
                                {busy === `revokeInvite:${u.id}` ? '…' : 'Revoke'}
                              </RowButton>
                            </>
                          ) : (
                            <>
                              {u.createdAt && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  Joined {formatDateTime(u.createdAt, me?.timezone)}
                                </span>
                              )}
                              <span className={`badge ${u.online ? 'badge-green' : 'badge-gray'}`} title={u.lastSeenAt ? `Last seen ${formatDateTime(u.lastSeenAt, me?.timezone)}` : 'Never signed in'}>
                                {u.online ? '● Online' : formatRelative(u.lastSeenAt) === '—' ? 'Never online' : `Offline · ${formatRelative(u.lastSeenAt)}`}
                              </span>
                              {lock && (
                                <span className="badge badge-red" title={lock.title}>{lock.text}</span>
                              )}
                              {failed && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="Wrong passwords since the last sign-in">{failed}</span>
                              )}
                              {mustSet && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="On a temporary password from an administrator">{mustSet}</span>
                              )}
                              {u.lastLoginAt && (
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                  Last sign-in {formatDateTime(u.lastLoginAt, me?.timezone)}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 14 }}>›</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Invite form. No password: the person is sent a link to set their
            own (emailed when Setup › Email sending is set up, otherwise
            shown here to pass on), and the result takes the form's place
            until Done. */}
        <div className="card" style={{ position: 'sticky', top: 80 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>
              ＋
            </div>
            <div>
              <div className="card-title">Invite a user</div>
            </div>
          </div>

          {invited ? (
            <LinkResult
              kind="invite"
              answer={invited.invite}
              email={invited.email}
              timeZone={me?.timezone}
              extra={invited.copied}
              onDone={() => setInvited(null)}
            />
          ) : (
            <>
              <div className="card-subtitle">
                They get a link to set their own password. You never see it.
              </div>

              <form onSubmit={handleCreate}>
                <div className="form-group">
                  <label htmlFor="admin-email" className="form-label">Email address</label>
                  <input id="admin-email"
                    type="email"
                    className="form-input"
                    placeholder="user@company.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required autoComplete="off" spellCheck={false} autoCapitalize="none"
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 22 }}>
                  <label className="form-label">Role</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['user', 'admin'].map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRole(r)}
                        style={{
                          flex: 1, padding: '9px 0',
                          borderRadius: 8, border: 'none', cursor: 'pointer',
                          fontSize: 13, fontWeight: 600,
                          background: role === r ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                          color: role === r ? '#fff' : 'var(--text-muted)',
                          boxShadow: role === r ? '0 2px 8px rgba(99,102,241,0.3)' : 'none',
                          transition: 'all 0.18s ease',
                        }}
                      >
                        {r === 'admin' ? '★ Admin' : '◦ User'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* A demo account shows sample data this app generates, and makes
                    no Xero connection. Ticking it offers this admin's own keys,
                    defaults and mailbox for the account (pages/admin/users.js),
                    all ticked to start. The mailbox copy needs a sender: two
                    accounts watching one mailbox must watch different senders,
                    and the server refuses the copy without one. */}
                <div className="form-group" style={{ marginBottom: 22 }}>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="checkbox" checked={demo} style={{ marginTop: 3 }}
                      onChange={e => { setDemo(e.target.checked); setCopyFrom(copyDefaults()); setFilterFrom(''); }}
                    />
                    <span><strong>Demo account</strong> — sample data, no Xero connection</span>
                  </label>
                  {demo && (
                    <div style={{ marginTop: 10, paddingLeft: 22 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                        Copy my settings to this account:
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 13 }}>
                        {copyBoxes().map(({ key, label }) => (
                          <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                            <input
                              type="checkbox" checked={!!copyFrom[key]}
                              onChange={e => setCopyFrom(prev => ({ ...prev, [key]: e.target.checked }))}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {copyFrom.mailbox && (
                        <div style={{ marginTop: 10 }}>
                          <label htmlFor="admin-filter-from" className="form-label">
                            Only process emails from
                            <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>(needed with Mailbox)</span>
                          </label>
                          <input id="admin-filter-from"
                            type="email"
                            className="form-input"
                            placeholder="sender address"
                            value={filterFrom}
                            onChange={e => setFilterFrom(e.target.value)}
                            required
                          />
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                            Two accounts watching one mailbox must watch different senders: the demo account only processes emails from this address.
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={inviting || !!createProblem}
                  title={createProblem || undefined}
                  style={{ width: '100%', justifyContent: 'center', padding: '11px 0', fontSize: 14 }}
                >
                  {inviting ? <><span className="btn-spinner" /> Inviting…</> : 'Invite user'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>}

      {tab === 'users' && detailUser && (
        <UserDetailPanel
          user={detailUser}
          isMe={detailUser.id === me?.id}
          lastAdmin={isLastAdmin(detailUser)}
          timeZone={me?.timezone}
          busy={busy}
          error={actionError}
          refreshKey={detailRefresh}
          actions={userActions}
          onClose={closeDetail}
          onPrev={detailPrev}
          onNext={detailNext}
        />
      )}

      {/* What New link or Send reset link came to, drawn over the panel
          (Modal sits above it). Closing it is Done: the link is not kept. */}
      {shownLink && (
        <Modal onClose={() => setShownLink(null)} maxWidth={480}
               label={shownLink.kind === 'reset' ? `Reset link for ${shownLink.email}` : `Invite for ${shownLink.email}`}>
          <div className="card-title" style={{ marginBottom: 12 }}>
            {shownLink.kind === 'reset' ? 'Reset link' : 'New invite link'}
          </div>
          <LinkResult
            kind={shownLink.kind}
            answer={shownLink.answer}
            email={shownLink.email}
            timeZone={me?.timezone}
            onDone={() => setShownLink(null)}
          />
        </Modal>
      )}
    </div>
  );
}

// ── Reports panel ─────────────────────────────────────────────────────────────
function ReportsPanel({ navigate, timezone }) {
  const [reports,   setReports]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [resolving, setResolving] = useState(null);
  const [error,     setError]     = useState('');
  // A failed load said "All clear — no reported issues", the one thing it
  // must never say without having looked.
  const [loadErr,   setLoadErr]   = useState('');

  async function fetchReports() {
    setLoading(true);
    try { const d = await api.get('/admin/reports'); setReports(d.reports || []); setLoadErr(''); }
    catch (err) { setLoadErr(err.message || 'Could not load the reports'); }
    finally { setLoading(false); }
  }

  // The route is /reports/:userId/:invoiceId/resolve — the owner's id is on
  // each report as _ownerId. This called it with the invoice id alone, got a
  // 404 and swallowed it, so the button never did anything.
  async function resolve(inv) {
    setResolving(inv.id);
    setError('');
    try {
      await api.patch(`/admin/reports/${inv._ownerId}/${inv.id}/resolve`, {});
      await fetchReports();
    } catch (err) { setError(err.message || 'Could not resolve the report'); }
    setResolving(null);
  }

  useEffect(() => { fetchReports(); }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 16 }}>
        <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading reports...
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div className="card-title">Reported Issues</div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>
            Invoices flagged by users that need your attention
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {reports.length > 0 && (
            <span className="badge badge-red">{reports.length} open</span>
          )}
          <button className="btn btn-outline btn-sm" onClick={fetchReports} aria-label="Refresh reports" title="Refresh reports">↻</button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          <span className="alert-icon">✕</span>{error}
        </div>
      )}

      {loadErr && (
        <RetryAlert message={reports.length ? `Could not refresh the reports. ${loadErr}` : `Could not load the reports. ${loadErr}`}
                    onRetry={fetchReports} />
      )}

      {reports.length === 0 ? (
        !loadErr && (
        <div className="empty-state" style={{ padding: '40px 0' }}>
          <div className="empty-state-icon">✓</div>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>All clear</div>
          <div style={{ fontSize: 13 }}>No reported issues</div>
        </div>
        )
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {reports.map(inv => (
            <div
              key={inv.id}
              style={{
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 12,
                padding: '16px 18px',
                background: 'var(--danger-subtle)',
                animation: 'fadeUp 0.2s ease',
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                    {inv.vendorName || 'Unknown Vendor'}
                    <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                      #{inv.invoiceNumber}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                    {fmtMoney(inv.totalAmount, inv.currency)} · {inv.invoiceDate || '—'}
                    {inv.hasPdf && <span className="badge badge-green" style={{ marginLeft: 8 }}>📄 PDF</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* Takes this tab's address along, so Back on the review
                      returns to Reports rather than to the AR & AP list. */}
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => navigate(`/invoices/${inv.id}`, { state: { from: '/admin?tab=reports', depth: 1 } })}
                  >
                    View →
                  </button>
                  <button
                    className="btn btn-success btn-sm"
                    disabled={resolving === inv.id}
                    onClick={() => resolve(inv)}
                  >
                    {resolving === inv.id ? '...' : '✓ Resolve'}
                  </button>
                </div>
              </div>

              {/* Reports */}
              {(inv.reports || []).map((r, i) => (
                <div
                  key={i}
                  style={{
                    padding: '10px 12px',
                    background: 'rgba(239,68,68,0.08)',
                    borderRadius: 8,
                    border: '1px solid rgba(239,68,68,0.15)',
                    marginTop: i > 0 ? 8 : 0,
                  }}
                >
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                    "{r.note}"
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
                    Reported by {r.userEmail} · {r.reportedAt ? formatDateTime(r.reportedAt, timezone) : ''}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Monitoring panel ───────────────────────────────────────────────────────────
function StatCard({ label, value }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function MonitoringPanel({ timezone, onViewLogs }) {
  const confirm = useConfirm();
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [daily,   setDaily]   = useState(null);
  // The timezone the server counted the chart's days in (its answer's
  // timeZone), named under the chart's title.
  const [dailyZone, setDailyZone] = useState(null);
  const [busy,    setBusy]    = useState(null);   // `key:userId` while a control is in flight
  const [actionError, setActionError] = useState('');
  // A failed first load used to render nothing at all — not even a heading.
  const [loadErr, setLoadErr] = useState('');

  // `silent` refreshes the table in place after a control, instead of
  // replacing the whole panel with the spinner.
  async function fetchMonitoring({ silent = false } = {}) {
    if (!silent) setLoading(true);
    try { setData(await api.get('/admin/monitoring')); setLoadErr(''); }
    catch (err) { setLoadErr(err.message || 'Could not load monitoring data'); }
    finally { if (!silent) setLoading(false); }
  }

  // A control sits inside a row whose own click opens that user's logs, so
  // the click must not bubble.
  async function control(e, key, u, send) {
    e.stopPropagation();
    setBusy(`${key}:${u.id}`); setActionError('');
    try { await send(); await fetchMonitoring({ silent: true }); }
    catch (err) { setActionError(err.message); }
    finally { setBusy(null); }
  }

  // The question and the request are the ones the Users panel uses
  // (stopWatcherAsk/Send, autoSubmitOffAsk/Send at the top of this file).
  async function stopWatcher(e, u) {
    e.stopPropagation();
    if (!(await confirm(stopWatcherAsk(u)))) return;
    await control(e, 'watcher', u, () => stopWatcherSend(u));
  }

  async function autoSubmitOff(e, u) {
    e.stopPropagation();
    if (!(await confirm(autoSubmitOffAsk(u)))) return;
    await control(e, 'auto', u, () => autoSubmitOffSend(u));
  }

  // `false` for a failed load, so the chart can say so rather than draw an
  // empty month as if nothing had been processed. The server counts the days
  // in this admin's own account timezone, the one every time on this page is
  // shown in; they were UTC days, which put a Singapore morning on the day
  // before.
  async function fetchDaily() {
    try {
      const d = await api.get('/admin/stats/daily?days=30');
      setDaily(d.days);
      setDailyZone(d.timeZone || null);
    }
    catch (_) { setDaily(false); }
  }

  useEffect(() => { fetchMonitoring(); fetchDaily(); }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 16 }}>
        <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading monitoring data...
      </div>
    );
  }

  if (!data) {
    return <RetryAlert message={`Could not load monitoring data. ${loadErr}`} onRetry={() => { fetchMonitoring(); fetchDaily(); }} />;
  }
  const { system, users } = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* System health */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="card-title">System Health</div>
          <button className="btn btn-outline btn-sm" onClick={() => { fetchMonitoring(); fetchDaily(); }}
                  aria-label="Refresh monitoring" title="Refresh monitoring">↻</button>
        </div>
        {loadErr && (
          <RetryAlert message={`Could not refresh — these figures are from the last load. ${loadErr}`}
                      onRetry={() => fetchMonitoring({ silent: true })} />
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <StatCard label="Uptime"        value={formatUptime(system.uptimeSeconds)} />
          <StatCard label="Node"          value={system.nodeVersion} />
          <StatCard label="Memory (RSS)"  value={`${system.memory.rssMb} MB`} />
          <StatCard label="Heap Used"     value={`${system.memory.heapUsedMb} MB`} />
          <StatCard label="DB Size"       value={system.dbSizeKb != null ? `${system.dbSizeKb} KB` : '—'} />
          <StatCard label="Logs Size"     value={system.logsSizeMb != null ? `${system.logsSizeMb} MB` : '—'} />
          <StatCard label="Total Users"   value={system.totalUsers} />
          <StatCard label="Total Invoices" value={system.totalInvoices} />
        </div>
      </div>

      {/* Invoice volume trend */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 2 }}>Invoice Volume — Last 30 Days</div>
        <div className="card-subtitle">
          Every user combined, by day processed{dailyZone ? ` (${dailyZone === 'UTC' ? 'UTC days' : `days in ${dailyZone}`})` : ''}
        </div>
        {daily === null ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
        ) : daily === false ? (
          <RetryAlert message="Could not load the daily volume." onRetry={() => { setDaily(null); fetchDaily(); }} style={{ marginBottom: 0 }} />
        ) : (
          <DailyVolumeChart data={daily} />
        )}
      </div>

      {/* Per-user activity */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 2 }}>Per-User Activity</div>
        <div className="card-subtitle">Click a row to view that user's logs</div>
        {actionError && <div className="alert alert-error"><span className="alert-icon">✕</span>{actionError}</div>}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                <th style={{ padding: '6px 10px' }}>User</th>
                <th style={{ padding: '6px 10px' }}>Online</th>
                <th style={{ padding: '6px 10px' }}>Watcher</th>
                <th style={{ padding: '6px 10px' }}>Auto-submit</th>
                <th style={{ padding: '6px 10px' }}>Xero</th>
                <th style={{ padding: '6px 10px' }}>IMAP</th>
                <th style={{ padding: '6px 10px' }}>Queue (pend/proc/dead)</th>
                <th style={{ padding: '6px 10px' }}>Invoices (pend/review/posted/err)</th>
                <th style={{ padding: '6px 10px' }} title="When the newest record arrived for this account">Last Activity</th>
                <th style={{ padding: '6px 10px' }}>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr
                  key={u.id}
                  onClick={() => onViewLogs?.(u.id, u.email)}
                  style={{ borderTop: '1px solid var(--border)', cursor: onViewLogs ? 'pointer' : undefined }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  title="View this user's logs"
                >
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    {u.email}
                    {u.disabled && <span className="badge badge-red" style={{ marginLeft: 6 }}>Disabled</span>}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className={`badge ${u.online ? 'badge-green' : 'badge-gray'}`}>
                      {u.online ? '● Online' : 'Offline'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <span className={`badge ${u.watcherRunning ? 'badge-green' : 'badge-gray'}`}>
                      {u.watcherRunning ? 'Running' : 'Stopped'}
                    </span>
                    {u.watcherRunning && (
                      <button className="btn btn-outline btn-sm" style={{ marginLeft: 6 }} disabled={!!busy}
                        title="Stop polling this mailbox" onClick={e => stopWatcher(e, u)}>
                        {busy === `watcher:${u.id}` ? '…' : 'Stop'}
                      </button>
                    )}
                  </td>
                  {/* Only OFF is offered: turning auto-submit on posts to a live
                      Xero and stays that user's own decision. */}
                  <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                    <span className={`badge ${u.autoProcess ? 'badge-yellow' : 'badge-gray'}`}>
                      {u.autoProcess ? 'On' : 'Off'}
                    </span>
                    {u.autoProcess && (
                      <button className="btn btn-outline btn-sm" style={{ marginLeft: 6 }} disabled={!!busy}
                        title="Stop this account posting to Xero automatically" onClick={e => autoSubmitOff(e, u)}>
                        {busy === `auto:${u.id}` ? '…' : 'Turn off'}
                      </button>
                    )}
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className={`badge ${u.xeroConnected ? 'badge-green' : 'badge-gray'}`}>
                      {u.xeroConnected ? 'Connected' : 'Not connected'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className={`badge ${u.imapConfigured ? 'badge-green' : 'badge-gray'}`}>
                      {u.imapConfigured ? 'Configured' : 'Not set'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    {u.queue.pending} / {u.queue.processing} / {u.queue.dead}
                  </td>
                  {/* Review-needed is the one that waits on a person; the
                      server always sent it and the column left it out. */}
                  <td style={{ padding: '8px 10px' }}>
                    {u.invoices.pending} / {u.invoices.reviewNeeded ?? 0} / {u.invoices.posted} / {u.invoices.error}
                  </td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }}>
                    {formatDateTime(u.lastActivity, timezone)}
                  </td>
                  <td style={{ padding: '8px 10px', color: 'var(--text-muted)' }} title={u.lastSeenAt ? formatDateTime(u.lastSeenAt, timezone) : 'Never signed in'}>
                    {formatRelative(u.lastSeenAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Daily invoice volume chart ───────────────────────────────────────────────
// Plain inline SVG — three status-colored lines (posted/error/pending), reusing
// this app's existing --success/--danger/--warning tokens so "error" here means
// the same red as everywhere else in the product. A hover crosshair + tooltip
// gives exact values; the legend is always text-labeled so identity never
// depends on color alone.
const CHART_SERIES = [
  { key: 'posted',  label: 'Posted',  color: 'var(--success)' },
  { key: 'error',   label: 'Error',   color: 'var(--danger)' },
  { key: 'pending', label: 'Pending', color: 'var(--warning)' },
];

function DailyVolumeChart({ data }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  if (!data || data.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>No invoice activity yet.</div>;
  }

  const W = 760, H = 200, PAD_L = 32, PAD_R = 12, PAD_T = 10, PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  const showOther = data.some(d => d.other > 0);
  const series = showOther ? [...CHART_SERIES, { key: 'other', label: 'Other', color: 'var(--text-muted)' }] : CHART_SERIES;

  const maxY = Math.max(1, ...data.flatMap(d => series.map(s => d[s.key] || 0)));
  const x = i => PAD_L + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = v => PAD_T + innerH - (v / maxY) * innerH;

  const linePath = key => data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[key] || 0).toFixed(1)}`).join(' ');

  // Y-axis ticks — 4 evenly spaced values including 0 and the max.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(maxY * f));

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (relX - PAD_L) / innerW));
    setHoverIdx(Math.round(frac * (data.length - 1)));
  }

  const hover = hoverIdx != null ? data[hoverIdx] : null;
  // Flip the tooltip to the left of the crosshair once it would run off the right
  // edge of the chart, rather than letting it clip.
  const tooltipRight = hoverIdx != null && x(hoverIdx) > W * 0.65;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
        {series.map(s => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: 'inline-block' }} />
            {s.label}
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', overflowX: 'auto' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', minWidth: 480, height: 'auto', display: 'block', cursor: 'crosshair' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {/* Recessive gridlines + y-axis labels */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
              <text x={PAD_L - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--text-muted)">{t}</text>
            </g>
          ))}

          {/* Sparse x-axis labels — first, middle, last day, to avoid a wall of text */}
          {[0, Math.floor((data.length - 1) / 2), data.length - 1].map(i => (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
              {data[i].day.slice(5)}
            </text>
          ))}

          {/* Series lines */}
          {series.map(s => (
            <path key={s.key} d={linePath(s.key)} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          ))}

          {/* Hover crosshair + per-series markers */}
          {hover && (
            <g>
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={PAD_T} y2={PAD_T + innerH} stroke="var(--text-muted)" strokeWidth="1" strokeDasharray="3,3" />
              {series.map(s => (
                <circle key={s.key} cx={x(hoverIdx)} cy={y(hover[s.key] || 0)} r="4" fill={s.color} stroke="var(--bg-card)" strokeWidth="2" />
              ))}
            </g>
          )}
        </svg>

        {hover && (
          <div style={{
            position: 'absolute', top: 4, [tooltipRight ? 'right' : 'left']: `${(x(hoverIdx) / W) * 100}%`,
            transform: tooltipRight ? 'translateX(8px)' : 'translateX(-108%)',
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
            padding: '8px 10px', fontSize: 11.5, boxShadow: 'var(--shadow-sm)', pointerEvents: 'none', minWidth: 110,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>{hover.day}</div>
            {series.map(s => (
              <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>{s.label}</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{hover[s.key] || 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Logs panel ──────────────────────────────────────────────────────────────
// Tails the live combined/error log so day-to-day debugging doesn't require
// SSH-ing into the server just to grep a file.
function levelStyle(level) {
  switch (level) {
    case 'error': return { background: 'var(--danger-subtle)', color: 'var(--danger)' };
    case 'warn':  return { background: 'rgba(245,158,11,0.12)', color: 'var(--warning)' };
    default:      return { background: 'var(--bg-hover)', color: 'var(--text-muted)' };
  }
}

function LogsPanel({ timezone, initialUserId, initialUserEmail }) {
  const [file,    setFile]    = useState('combined');
  // Seeded from the Monitoring tab's row click — this panel remounts fresh each
  // time the parent switches `tab` to 'logs' (conditional rendering, not a CSS
  // show/hide), so the prop's value at that moment is exactly what's wanted here.
  const [userId,  setUserId]  = useState(initialUserId || '');
  const [q,       setQ]       = useState('');
  const [lines,   setLines]   = useState(200);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  // Kept apart from "no matching entries": a log that could not be read is
  // not a quiet log.
  const [loadErr, setLoadErr] = useState('');

  // Overrides exist because a setState is not visible until the next render;
  // a change handler that sets a value and fetches in the same breath must
  // hand the new value over itself or fetch with the old one.
  async function fetchLogs(overrideFile, overrideUserId, overrideLines) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ file: overrideFile || file, lines: String(overrideLines ?? lines) });
      const uid = overrideUserId !== undefined ? overrideUserId : userId;
      if (uid.trim())    params.set('userId', uid.trim());
      if (q.trim())      params.set('q', q.trim());
      const d = await api.get(`/admin/logs?${params.toString()}`);
      setEntries(d.entries || []);
      setLoadErr('');
    } catch (err) {
      setEntries([]);
      setLoadErr(err.message || 'Could not read the log');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchLogs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function selectFile(f) {
    setFile(f);
    fetchLogs(f);
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div className="card-title">Server Logs</div>
          <div className="card-subtitle" style={{ marginBottom: 0 }}>
            Live tail of the active log file — no SSH needed for day-to-day debugging.
          </div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => fetchLogs()} aria-label="Refresh logs" title="Refresh logs">↻</button>
      </div>

      {initialUserId && userId === initialUserId && (
        <div className="alert" style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', marginBottom: 14 }}>
          <span className="alert-icon">👤</span>
          Showing logs for {initialUserEmail || `user ${initialUserId}`} only.
          <button
            type="button" className="btn btn-sm" style={{ marginLeft: 'auto', background: 'none', color: 'var(--accent)', border: '1px solid currentColor' }}
            onClick={() => { setUserId(''); fetchLogs(undefined, ''); }}
          >
            Clear filter
          </button>
        </div>
      )}

      <form
        onSubmit={e => { e.preventDefault(); fetchLogs(); }}
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 14 }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {[{ key: 'combined', label: 'All' }, { key: 'error', label: 'Errors only' }].map(f => (
            <button
              key={f.key} type="button" onClick={() => selectFile(f.key)}
              className="btn btn-sm"
              style={{
                background: file === f.key ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                color:      file === f.key ? '#fff' : 'var(--text-muted)',
                border:     file === f.key ? 'none' : '1px solid var(--border)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          type="text" className="form-input" placeholder="Filter by user ID…" aria-label="Filter by user ID"
          value={userId} onChange={e => setUserId(e.target.value)}
          style={{ maxWidth: 190 }}
        />
        <input
          type="text" className="form-input" placeholder="Search message…" aria-label="Search log messages"
          value={q} onChange={e => setQ(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <select
          className="form-input" value={lines} aria-label="Lines to show"
          onChange={e => { const n = Number(e.target.value); setLines(n); fetchLogs(undefined, undefined, n); }}
          style={{ maxWidth: 110 }}
        >
          {[100, 200, 500, 1000].map(n => <option key={n} value={n}>{n} lines</option>)}
        </select>
        <button type="submit" className="btn btn-primary btn-sm">Search</button>
      </form>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '16px 0' }}>
          <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
          Loading...
        </div>
      ) : loadErr ? (
        <RetryAlert message={`Could not read the log. ${loadErr}`} onRetry={() => fetchLogs()} style={{ marginBottom: 0 }} />
      ) : entries.length === 0 ? (
        <div className="empty-state" style={{ padding: '30px 0' }}>
          <div className="empty-state-icon">📄</div>
          <div>No matching log entries</div>
        </div>
      ) : (
        <div style={{
          fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6,
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '4px 12px', maxHeight: 480, overflowY: 'auto',
        }}>
          {entries.map((e, i) => {
            const c = levelStyle(e.level);
            return (
              <div
                key={i} title={JSON.stringify(e, null, 2)}
                style={{
                  display: 'flex', gap: 8, padding: '5px 0', alignItems: 'flex-start',
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {formatDateTime(e.timestamp, timezone)}
                </span>
                <span style={{
                  background: c.background, color: c.color, borderRadius: 4, padding: '1px 6px',
                  fontWeight: 700, fontSize: 10, textTransform: 'uppercase', whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                  {e.level || 'info'}
                </span>
                <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>
                  {e.message}
                  {(e.userId || e.by) && (
                    <span style={{ color: 'var(--text-muted)' }}> — {e.userId ? `user:${e.userId}` : e.by}</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
