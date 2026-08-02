import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { usePipeline } from '../context/PipelineContext';
import ProcessToggle from '../components/ProcessToggle';
import InvoiceTable from '../components/InvoiceTable';

function StatCard({ label, value, sub, icon, iconBg, color, delay = 0 }) {
  return (
    <div className="stat-card" style={{ animationDelay: `${delay}ms` }}>
      <div className="stat-icon" style={{ background: iconBg }}>
        {icon}
      </div>
      <div className="stat-value" style={{ color: color || 'var(--text-primary)' }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 44, height: 24,
        borderRadius: 100,
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--bg-hover)',
        transition: 'background 0.2s ease',
        flexShrink: 0,
        boxShadow: checked ? '0 0 0 3px rgba(99,102,241,0.2)' : 'none',
      }}
    >
      <span style={{
        position: 'absolute',
        top: 3, left: checked ? 23 : 3,
        width: 18, height: 18,
        borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.2s ease',
        boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
      }} />
    </button>
  );
}

// ── Queue Panel ───────────────────────────────────────────────────────────────
function QueueJob({ job }) {
  const isActive = job.status === 'processing';
  const isDead   = job.status === 'dead';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      padding: '12px 14px', borderRadius: 10,
      background: isActive ? 'rgba(99,102,241,0.06)' : 'var(--bg-secondary)',
      border: `1px solid ${isActive ? 'rgba(99,102,241,0.25)' : isDead ? 'rgba(239,68,68,0.2)' : 'var(--border)'}`,
      transition: 'all 0.2s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {isActive ? (
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--accent)',
            boxShadow: '0 0 0 3px rgba(99,102,241,0.25)',
            animation: 'pulse 1.4s ease-in-out infinite',
            flexShrink: 0,
          }} />
        ) : (
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: isDead ? 'var(--danger)' : 'var(--border)',
            flexShrink: 0,
          }} />
        )}
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
          color: isActive ? 'var(--accent)' : isDead ? 'var(--danger)' : 'var(--text-muted)',
          textTransform: 'uppercase',
        }}>
          {isActive ? 'Processing' : isDead ? 'Failed' : 'Pending'}
        </span>
        {job.attempts > 1 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            attempt {job.attempts}
          </span>
        )}
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>
        {job.subject || '(no subject)'}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {job.from}
      </div>

      {job.pdfs?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {job.pdfs.slice(0, 3).map((pdf, i) => (
            <span key={i} style={{
              fontSize: 11, padding: '2px 7px', borderRadius: 4,
              background: isActive ? 'rgba(99,102,241,0.12)' : 'var(--bg-hover)',
              color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
              border: `1px solid ${isActive ? 'rgba(99,102,241,0.2)' : 'var(--border)'}`,
            }}>
              📄 {pdf.length > 30 ? pdf.slice(0, 28) + '…' : pdf}
            </span>
          ))}
          {job.pdfs.length > 3 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 4px' }}>
              +{job.pdfs.length - 3} more
            </span>
          )}
        </div>
      )}

      {/* Indeterminate progress bar for active job */}
      {isActive && (
        <div style={{
          height: 3, borderRadius: 2, background: 'var(--bg-hover)',
          overflow: 'hidden', marginTop: 4,
        }}>
          <div style={{
            height: '100%', width: '40%',
            background: 'linear-gradient(90deg, transparent, var(--accent), transparent)',
            animation: 'scanline 1.6s ease-in-out infinite',
          }} />
        </div>
      )}

      {isDead && job.lastError && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>
          {job.lastError}
        </div>
      )}
    </div>
  );
}

function Chip({ label, count, color, bg, border }) {
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 700,
      background: bg, color, border: `1px solid ${border}`,
    }}>
      {count} {label}
    </span>
  );
}

function PipelinePanel({ queue, xero }) {
  const emailActive = queue && (queue.processing > 0 || queue.pending > 0 || queue.dead > 0);
  const xeroActive  = xero  && (xero.pending > 0 || xero.error > 0);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-title" style={{ marginBottom: 14 }}>Pipeline Status</div>

      {/* Email / LLM parsing row */}
      <div style={{ marginBottom: emailActive ? 14 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: emailActive ? 10 : 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', minWidth: 130 }}>
            Email parsing
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {queue?.processing > 0 && <Chip label="active"   count={queue.processing} color="var(--accent)"   bg="rgba(99,102,241,0.12)"  border="rgba(99,102,241,0.2)" />}
            {queue?.pending   > 0 && <Chip label="queued"   count={queue.pending}    color="var(--text-muted)" bg="var(--bg-hover)"        border="var(--border)" />}
            {queue?.dead      > 0 && <Chip label="failed"   count={queue.dead}       color="var(--danger)"    bg="rgba(239,68,68,0.08)"   border="rgba(239,68,68,0.2)" />}
            {!emailActive && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Idle</span>}
          </div>
        </div>
        {emailActive && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(queue?.jobs || []).map(job => <QueueJob key={job.id} job={job} />)}
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border)', margin: '12px 0' }} />

      {/* Xero submission row */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', minWidth: 130 }}>
            Xero submission
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {xero?.submitting > 0 && <Chip label="submitting" count={xero.submitting} color="var(--accent)"   bg="rgba(99,102,241,0.12)"  border="rgba(99,102,241,0.2)" />}
            {xero?.pending    > 0 && <Chip label="pending"    count={xero.pending}    color="var(--warning)"  bg="rgba(245,158,11,0.08)"  border="rgba(245,158,11,0.2)" />}
            {xero?.posted     > 0 && <Chip label="posted"     count={xero.posted}     color="var(--success)"  bg="rgba(16,185,129,0.08)"  border="rgba(16,185,129,0.2)" />}
            {xero?.error      > 0 && <Chip label="failed"     count={xero.error}      color="var(--danger)"   bg="rgba(239,68,68,0.08)"   border="rgba(239,68,68,0.2)" />}
            {!xeroActive && !xero?.posted && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No invoices yet</span>}
          </div>
        </div>

        {/* Progress bar — only when there are invoices to track */}
        {xero && (xero.pending + xero.submitting + xero.posted + xero.error) > 0 && (() => {
          const total      = xero.pending + xero.submitting + xero.posted + xero.error;
          const pctPosted  = (xero.posted     / total) * 100;
          const pctActive  = (xero.submitting / total) * 100;
          const pctFailed  = (xero.error      / total) * 100;
          const isComplete = xero.posted === total;
          return (
            <div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-hover)', overflow: 'hidden', position: 'relative' }}>
                {/* Posted — green */}
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${pctPosted}%`, background: 'var(--success)', transition: 'width 0.6s ease', borderRadius: 3 }} />
                {/* Submitting — animated accent */}
                <div style={{ position: 'absolute', left: `${pctPosted}%`, top: 0, height: '100%', width: `${pctActive}%`, background: 'var(--accent)', overflow: 'hidden' }}>
                  {pctActive > 0 && (
                    <div style={{ height: '100%', width: '60%', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)', animation: 'scanline 1.4s ease-in-out infinite' }} />
                  )}
                </div>
                {/* Failed — red, at the right end */}
                <div style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: `${pctFailed}%`, background: 'var(--danger)', borderRadius: '0 3px 3px 0' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                <span>{isComplete ? 'All invoices posted to Xero' : `${xero.posted} of ${total} posted`}</span>
                {xero.error > 0 && <span style={{ color: 'var(--danger)' }}>{xero.error} failed — open invoice to fix</span>}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

export default function Dashboard() {
  // Status comes from the shared PipelineContext — no need for a separate polling loop here.
  const { status, refresh: refreshStatus } = usePipeline();

  const [invoices,    setInvoices]    = useState([]);
  const [settings,    setSettings]    = useState({ autoProcess: true });
  const [loading,     setLoading]     = useState(true);
  const [rescanning,  setRescanning]  = useState(false);
  const [rescanMsg,   setRescanMsg]   = useState('');
  const [togglingAP,  setTogglingAP]  = useState(false);

  const fetchInvoices = useCallback(async () => {
    try { const d = await api.get('/invoices'); setInvoices(d.invoices || []); } catch (_) {}
  }, []);

  const fetchSettings = useCallback(async () => {
    try { setSettings(await api.get('/process/settings')); } catch (_) {}
  }, []);

  useEffect(() => {
    Promise.all([fetchInvoices(), fetchSettings()]).finally(() => setLoading(false));

    // Poll invoices every 15 s (the queue/xero counts come from PipelineContext).
    const id = setInterval(fetchInvoices, 15000);
    return () => clearInterval(id);
  }, [fetchInvoices, fetchSettings]);

  async function handleAutoProcessToggle(val) {
    setTogglingAP(true);
    try {
      const updated = await api.patch('/process/settings', { autoProcess: val });
      setSettings(updated);
    } catch (_) {}
    setTogglingAP(false);
  }

  async function handleRescan() {
    setRescanning(true);
    setRescanMsg('');
    const prevCheckedAt = status?.lastScan?.checkedAt || null;
    try {
      await api.post('/process/rescan', {});

      // The IMAP search itself is async on the backend — poll status until it
      // reports a fresh lastScan (bounded so a slow/stuck mailbox can't hang the UI).
      let result = null;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1200));
        const s = await refreshStatus();
        if (s?.lastScan?.checkedAt && s.lastScan.checkedAt !== prevCheckedAt) {
          result = s.lastScan;
          break;
        }
      }

      if (result) {
        setRescanMsg(
          result.emailsFound > 0
            ? `Found ${result.emailsFound} new email${result.emailsFound === 1 ? '' : 's'} — processing...`
            : 'No new emails found.'
        );
      } else {
        setRescanMsg('Still checking — this is taking longer than usual.');
      }
      fetchInvoices();
    } catch (err) {
      setRescanMsg(err.message);
    } finally {
      setRescanning(false);
      setTimeout(() => setRescanMsg(''), 6000);
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', padding: 16 }}>
        <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
        Loading...
      </div>
    );
  }

  const running = status?.running;

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Monitor your email-to-Xero invoice pipeline in real time</p>
      </div>

      {/* Stats */}
      <div className="grid-3" style={{ marginBottom: 22 }}>
        <StatCard
          icon="⚡"
          iconBg={running ? 'rgba(16,185,129,0.15)' : 'var(--bg-hover)'}
          label="Watcher status"
          value={running ? 'Active' : 'Stopped'}
          color={running ? 'var(--success)' : 'var(--text-muted)'}
          sub={running ? 'Polling every 60 sec' : 'Not monitoring emails'}
          delay={0}
        />
        <StatCard
          icon="📄"
          iconBg="rgba(99,102,241,0.12)"
          label="Invoices processed"
          value={status?.invoiceCount ?? 0}
          color="var(--accent)"
          sub="since last server restart"
          delay={60}
        />
        <StatCard
          icon="🕐"
          iconBg="rgba(245,158,11,0.12)"
          label="Last activity"
          value={status?.lastActivity ? new Date(status.lastActivity).toLocaleTimeString() : '—'}
          color="var(--warning)"
          sub={status?.lastActivity ? new Date(status.lastActivity).toLocaleDateString() : 'No activity yet'}
          delay={120}
        />
      </div>

      {/* Pipeline status — always visible */}
      <PipelinePanel queue={status?.queue} xero={status?.xero} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>

        {/* Watcher control */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, gap: 16 }}>
            <div>
              <div className="card-title">Email Watcher</div>
              <div className="card-subtitle" style={{ marginBottom: 0 }}>
                Persistent IMAP connection. New emails are detected in real time; polls every 60 s as fallback.
              </div>
            </div>
            <span style={{
              padding: '4px 10px', borderRadius: 100, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              background: running ? 'var(--success-subtle)' : 'var(--bg-hover)',
              color: running ? 'var(--success)' : 'var(--text-muted)',
            }}>
              {running ? '● Live' : '○ Idle'}
            </span>
          </div>
          <ProcessToggle status={status} onUpdate={refreshStatus} />
        </div>

        {/* Auto-process + rescan */}
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Processing mode</div>
          <div className="card-subtitle">Control how detected invoices are handled.</div>

          {/* Auto-process row */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 16px', borderRadius: 10,
            background: settings.autoProcess ? 'var(--accent-subtle)' : 'var(--bg-secondary)',
            border: `1px solid ${settings.autoProcess ? 'rgba(99,102,241,0.2)' : 'var(--border)'}`,
            marginBottom: 12,
            transition: 'all 0.2s ease',
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 2 }}>
                Auto-submit to Xero
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {settings.autoProcess
                  ? 'Invoices are pushed to Xero automatically on detection'
                  : 'Invoices are stored for manual review — not sent to Xero'}
              </div>
            </div>
            <Toggle
              checked={settings.autoProcess}
              onChange={handleAutoProcessToggle}
              disabled={togglingAP}
            />
          </div>

          {/* Rescan row */}
          <div style={{
            padding: '14px 16px', borderRadius: 10,
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 2 }}>
                  Re-scan inbox now
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Scans for unread emails immediately. Mark an email as unread in Gmail to re-process it.
                </div>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={handleRescan}
                disabled={rescanning || !running}
                style={{ whiteSpace: 'nowrap', marginLeft: 12 }}
                title={!running ? 'Start the watcher first' : 'Scan inbox for unread emails now'}
              >
                {rescanning ? '...' : '⟳ Scan now'}
              </button>
            </div>
            {rescanMsg && (
              <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 6, fontWeight: 500 }}>
                {rescanMsg}
              </div>
            )}
            {!rescanMsg && status?.lastScan && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Last checked {new Date(status.lastScan.checkedAt).toLocaleTimeString()} —{' '}
                {status.lastScan.emailsFound > 0
                  ? `found ${status.lastScan.emailsFound} email${status.lastScan.emailsFound === 1 ? '' : 's'}`
                  : 'no new emails'}
              </div>
            )}
            {!running && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
                Start the watcher to enable rescanning.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent invoices */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div className="card-title">Recent Invoices</div>
            <div className="card-subtitle" style={{ marginBottom: 0 }}>
              Showing last {Math.min(invoices.length, 10)} of {invoices.length} — up to 100 kept in memory
            </div>
          </div>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => { refreshStatus(); fetchInvoices(); }}
          >
            ↻ Refresh
          </button>
        </div>
        <InvoiceTable invoices={invoices.slice(0, 10)} />
      </div>
    </div>
  );
}
