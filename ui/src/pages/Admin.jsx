import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatDateTime, formatRelative } from '../utils/formatDate';

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

export default function Admin() {
  const { user: me } = useAuth();
  const navigate     = useNavigate();
  const [tab, setTab] = useState('users');
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
  const [email,   setEmail]   = useState('');
  const [pass,    setPass]    = useState('');
  const [showPass, setShowPass] = useState(false);
  const [role,    setRole]    = useState('user');
  const [error,   setError]   = useState('');
  const [success, setSuccess] = useState('');
  const [deleting, setDeleting] = useState(null);

  async function fetchUsers() {
    try { const d = await api.get('/admin/users'); setUsers(d.users || []); } catch (_) {}
  }

  useEffect(() => {
    fetchUsers().finally(() => setLoading(false));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await api.post('/admin/users', { email, password: pass, role });
      setEmail(''); setPass(''); setRole('user');
      setSuccess(`User ${email} created.`);
      setTimeout(() => setSuccess(''), 4000);
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDelete(id, userEmail) {
    if (!confirm(`Delete ${userEmail}?\nThis cannot be undone.`)) return;
    setDeleting(id); setError('');
    try {
      await api.delete(`/admin/users/${id}`);
      await fetchUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  }

  const admins = users.filter(u => u.role === 'admin');

  return (
    <div>
      <div className="page-header">
        <h1>Admin</h1>
        <p>Manage users and review flagged invoice issues.</p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, marginBottom: 20, width: 'fit-content' }}>
        {[{ key: 'users', label: '👥 Users' }, { key: 'reports', label: '⚠ Reports' }, { key: 'monitoring', label: '📊 Monitoring' }, { key: 'logs', label: '📄 Logs' }].map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} style={{
            padding: '7px 18px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
            background: tab === t.key ? 'var(--accent-gradient)' : 'transparent',
            color: tab === t.key ? '#fff' : 'var(--text-muted)',
            boxShadow: tab === t.key ? '0 2px 8px rgba(99,102,241,0.3)' : 'none',
            transition: 'all 0.18s ease',
          }}>{t.label}</button>
        ))}
      </div>

      {error   && <div className="alert alert-error"><span className="alert-icon">✕</span>{error}</div>}
      {success && <div className="alert alert-success"><span className="alert-icon">✓</span>{success}</div>}

      {tab === 'reports'    && <ReportsPanel navigate={navigate} />}
      {tab === 'monitoring' && <MonitoringPanel timezone={me?.timezone} onViewLogs={viewUserLogs} />}
      {tab === 'logs'       && <LogsPanel timezone={me?.timezone} initialUserId={logsUserId} initialUserEmail={logsUserEmail} />}

      {tab === 'users' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, alignItems: 'start' }}>

        {/* Users list */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
            <div>
              <div className="card-title">Users</div>
              <div className="card-subtitle" style={{ marginBottom: 0 }}>{users.length} account{users.length !== 1 ? 's' : ''} total</div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={fetchUsers}>↻</button>
          </div>

          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: '16px 0' }}>
              <span style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
              Loading...
            </div>
          ) : users.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">👥</div>
              <div>No users found</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {users.map((u, i) => (
                <div
                  key={u.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '11px 12px', borderRadius: 10,
                    background: u.id === me?.id ? 'var(--accent-subtle)' : 'transparent',
                    border: u.id === me?.id ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent',
                    transition: 'all 0.15s',
                    animation: `fadeUp 0.25s ease ${i * 40}ms both`,
                  }}
                  onMouseEnter={e => { if (u.id !== me?.id) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { if (u.id !== me?.id) e.currentTarget.style.background = 'transparent'; }}
                >
                  <Avatar email={u.email} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {u.email}
                      </span>
                      {u.id === me?.id && (
                        <span style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 600 }}>you</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                      <span className={`badge ${u.role === 'admin' ? 'badge-yellow' : 'badge-gray'}`}>
                        {u.role === 'admin' ? '★ ' : ''}{u.role}
                      </span>
                      {u.createdAt && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          Joined {formatDateTime(u.createdAt, me?.timezone)}
                        </span>
                      )}
                      <span className={`badge ${u.online ? 'badge-green' : 'badge-gray'}`} title={u.lastSeenAt ? `Last seen ${formatDateTime(u.lastSeenAt, me?.timezone)}` : 'Never signed in'}>
                        {u.online ? '● Online' : formatRelative(u.lastSeenAt) === '—' ? 'Never online' : `Offline · ${formatRelative(u.lastSeenAt)}`}
                      </span>
                    </div>
                  </div>

                  {u.id !== me?.id && (
                    <button
                      className="btn btn-sm"
                      disabled={deleting === u.id}
                      onClick={() => handleDelete(u.id, u.email)}
                      style={{
                        background: 'var(--danger-subtle)', color: 'var(--danger)',
                        border: '1px solid rgba(239,68,68,0.2)',
                        opacity: (u.role === 'admin' && admins.length <= 1) ? 0.3 : 1,
                      }}
                      title={u.role === 'admin' && admins.length <= 1 ? 'Cannot delete last admin' : 'Delete user'}
                    >
                      {deleting === u.id ? '...' : '✕'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Create form */}
        <div className="card" style={{ position: 'sticky', top: 80 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17 }}>
              ＋
            </div>
            <div>
              <div className="card-title">Add User</div>
            </div>
          </div>
          <div className="card-subtitle">New users can sign in immediately after creation.</div>

          <form onSubmit={handleCreate}>
            <div className="form-group">
              <label className="form-label">Email address</label>
              <input
                type="email"
                className="form-input"
                placeholder="user@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPass ? 'text' : 'password'}
                  className="form-input"
                  placeholder="Min. 6 characters"
                  value={pass}
                  onChange={e => setPass(e.target.value)}
                  required minLength={6}
                  style={{ paddingRight: 38 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }}
                >
                  {showPass ? '🙈' : '👁'}
                </button>
              </div>
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

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '11px 0', fontSize: 14 }}
            >
              Create account
            </button>
          </form>
        </div>
      </div>}
    </div>
  );
}

// ── Reports panel ─────────────────────────────────────────────────────────────
function ReportsPanel({ navigate }) {
  const [reports,   setReports]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [resolving, setResolving] = useState(null);

  async function fetchReports() {
    setLoading(true);
    try { const d = await api.get('/admin/reports'); setReports(d.reports || []); }
    catch (_) {}
    finally { setLoading(false); }
  }

  async function resolve(id) {
    setResolving(id);
    try {
      await api.patch(`/admin/reports/${id}/resolve`, {});
      await fetchReports();
    } catch (_) {}
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
          <button className="btn btn-outline btn-sm" onClick={fetchReports}>↻</button>
        </div>
      </div>

      {reports.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px 0' }}>
          <div className="empty-state-icon">✓</div>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>All clear</div>
          <div style={{ fontSize: 13 }}>No reported issues</div>
        </div>
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
                    {inv.currency} {Number(inv.totalAmount || 0).toFixed(2)} · {inv.invoiceDate || '—'}
                    {inv.hasPdf && <span className="badge badge-green" style={{ marginLeft: 8 }}>📄 PDF</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => navigate(`/invoices/${inv.id}`)}
                  >
                    View →
                  </button>
                  <button
                    className="btn btn-success btn-sm"
                    disabled={resolving === inv.id}
                    onClick={() => resolve(inv.id)}
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
                    Reported by {r.userEmail} · {r.reportedAt ? new Date(r.reportedAt).toLocaleString() : ''}
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
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [daily,   setDaily]   = useState(null);

  async function fetchMonitoring() {
    setLoading(true);
    try { setData(await api.get('/admin/monitoring')); }
    catch (_) {}
    finally { setLoading(false); }
  }

  async function fetchDaily() {
    try { setDaily((await api.get('/admin/stats/daily?days=30')).days); }
    catch (_) { setDaily([]); }
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

  if (!data) return null;
  const { system, users } = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* System health */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="card-title">System Health</div>
          <button className="btn btn-outline btn-sm" onClick={() => { fetchMonitoring(); fetchDaily(); }}>↻</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <StatCard label="Uptime"        value={formatUptime(system.uptimeSeconds)} />
          <StatCard label="Node"          value={system.nodeVersion} />
          <StatCard label="Memory (RSS)"  value={`${system.memory.rssMb} MB`} />
          <StatCard label="Heap Used"     value={`${system.memory.heapUsedMb} MB`} />
          <StatCard label="DB Size"       value={system.dbSizeKb != null ? `${system.dbSizeKb} KB` : '—'} />
          <StatCard label="Logs Size"     value={system.logsSizeMb != null ? `${system.logsSizeMb} MB` : '—'} />
          <StatCard label="Redis"         value={system.redisConfigured ? 'Configured' : 'Not set'} />
          <StatCard label="Total Users"   value={system.totalUsers} />
          <StatCard label="Total Invoices" value={system.totalInvoices} />
        </div>
      </div>

      {/* Invoice volume trend */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 2 }}>Invoice Volume — Last 30 Days</div>
        <div className="card-subtitle">Every user combined, by day processed</div>
        {daily === null ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
        ) : (
          <DailyVolumeChart data={daily} />
        )}
      </div>

      {/* Per-user activity */}
      <div className="card">
        <div className="card-title" style={{ marginBottom: 2 }}>Per-User Activity</div>
        <div className="card-subtitle">Click a row to view that user's logs</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                <th style={{ padding: '6px 10px' }}>User</th>
                <th style={{ padding: '6px 10px' }}>Online</th>
                <th style={{ padding: '6px 10px' }}>Watcher</th>
                <th style={{ padding: '6px 10px' }}>Xero</th>
                <th style={{ padding: '6px 10px' }}>IMAP</th>
                <th style={{ padding: '6px 10px' }}>Queue (pend/proc/dead)</th>
                <th style={{ padding: '6px 10px' }}>Invoices (pend/posted/err)</th>
                <th style={{ padding: '6px 10px' }}>Last Activity</th>
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
                  <td style={{ padding: '8px 10px' }}>{u.email}</td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className={`badge ${u.online ? 'badge-green' : 'badge-gray'}`}>
                      {u.online ? '● Online' : 'Offline'}
                    </span>
                  </td>
                  <td style={{ padding: '8px 10px' }}>
                    <span className={`badge ${u.watcherRunning ? 'badge-green' : 'badge-gray'}`}>
                      {u.watcherRunning ? 'Running' : 'Stopped'}
                    </span>
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
                  <td style={{ padding: '8px 10px' }}>
                    {u.invoices.pending} / {u.invoices.posted} / {u.invoices.error}
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

  async function fetchLogs(overrideFile, overrideUserId) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ file: overrideFile || file, lines: String(lines) });
      const uid = overrideUserId !== undefined ? overrideUserId : userId;
      if (uid.trim())    params.set('userId', uid.trim());
      if (q.trim())      params.set('q', q.trim());
      const d = await api.get(`/admin/logs?${params.toString()}`);
      setEntries(d.entries || []);
    } catch (_) {
      setEntries([]);
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
        <button className="btn btn-outline btn-sm" onClick={() => fetchLogs()}>↻</button>
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
          type="text" className="form-input" placeholder="Filter by user ID…"
          value={userId} onChange={e => setUserId(e.target.value)}
          style={{ maxWidth: 190 }}
        />
        <input
          type="text" className="form-input" placeholder="Search message…"
          value={q} onChange={e => setQ(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <select
          className="form-input" value={lines}
          onChange={e => { const n = Number(e.target.value); setLines(n); fetchLogs(); }}
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
