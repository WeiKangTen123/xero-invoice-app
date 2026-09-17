import { useEffect, useRef, useState } from 'react';
import Modal from '../Modal';
import { api } from '../../api/client';
import { blobToBase64, humanSize } from '../receipts/receipt-upload';

// The one import dialog: pick files, submit them as a background job, watch it,
// read the outcome per file. Bills and invoices differ only in what they
// accept and how the request body is shaped — both are props — so the chrome,
// the polling and the summary are written once.

const POLL_MS = 1500;

export async function encodeFiles(files) {
  return Promise.all(files.map(async f => ({ name: f.name, data: await blobToBase64(f) })));
}

export default function ImportDialog({
  title, subtitle, accept, hint,
  classify,            // file -> 'pdf' | 'zip' | 'sheet' | null (null = will not be sent)
  buildBody,           // async (files) -> request body for POST /invoices/import
  runningLabel = 'Reading',
  summary,             // (result) -> [{ n, label, tone }]
  failures,            // (result) -> [{ file, row?, error }]
  onClose, onImported, initialJobId = null,
}) {
  const fileRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [job, setJob]     = useState(initialJobId ? { id: initialJobId, stage: 'queued' } : null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const active = job && !['done', 'failed', 'cancelled'].includes(job.stage);
  const done   = job?.stage === 'done';
  const failed = job?.stage === 'failed' || job?.stage === 'cancelled';

  useEffect(() => {
    if (!job?.id || !active) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const next = await api.get(`/invoices/import/${job.id}`);
        if (stop) return;
        setJob(next);
        if (next.stage === 'done') onImported?.();
      } catch { /* transient — next tick retries */ }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [job?.id, active, onImported]);

  const sendable    = files.filter(f => classify(f) && f.size > 0);
  const unsupported = files.filter(f => !classify(f));

  async function start() {
    setStarting(true); setError('');
    try {
      const res = await api.post('/invoices/import', await buildBody(sendable));
      setJob({ id: res.jobId, stage: res.stage, filesTotal: 0, filesRead: 0 });
    } catch (err) {
      setError(err.message || 'Could not start the import');
    } finally { setStarting(false); }
  }

  const r = job?.result;
  return (
    <Modal onClose={onClose} busy={active} maxWidth={560} card label={title}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>{subtitle}</div>
          </div>
          <button onClick={onClose} disabled={active} aria-label="Close"
                  style={{ background: 'none', border: 'none', cursor: active ? 'not-allowed' : 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1, opacity: active ? 0.4 : 1 }}>×</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span className="alert-icon">✕</span>{error}</div>}

        {!job && (
          <>
            <input ref={fileRef} type="file" accept={accept} multiple style={{ display: 'none' }} onChange={e => setFiles(Array.from(e.target.files || []))} />
            <div onClick={() => fileRef.current?.click()} style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '26px 18px', textAlign: 'center', cursor: 'pointer', marginBottom: 14 }}>
              <div style={{ fontSize: 22, opacity: 0.5 }}>🗂</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>Choose the files</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div>
            </div>
            {files.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {files.map(f => {
                  const kind = classify(f);
                  const bad = !kind || f.size === 0;
                  return (
                    <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '6px 0', borderTop: '1px solid var(--border)', opacity: bad ? 0.6 : 1 }}>
                      <span style={{ color: bad ? 'var(--danger)' : undefined }}>{bad ? '⚠' : kind === 'zip' ? '🗜' : kind === 'sheet' ? '📊' : '📄'} {f.name}</span>
                      <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{f.size === 0 ? 'empty' : humanSize(f.size)}</span>
                    </div>
                  );
                })}
                {unsupported.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 8 }}>⚠ {unsupported.map(f => f.name).join(', ')} will not be sent.</div>
                )}
              </div>
            )}
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={!sendable.length || starting} onClick={start}>
              {starting ? <><span className="btn-spinner" /> Starting…</> : sendable.length ? title : 'Attach files to continue'}
            </button>
          </>
        )}

        {active && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-secondary)', padding: '7px 0' }}>
              <span>{job.stage === 'queued' ? 'Waiting to start' : runningLabel}</span>
              {job.filesTotal > 0 && <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{job.filesRead} / {job.filesTotal}</span>}
            </div>
            {job.filesTotal > 0 && (
              <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-hover)', overflow: 'hidden', margin: '8px 0' }}>
                <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width .3s ease', width: `${Math.round((job.filesRead / job.filesTotal) * 100)}%` }} />
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>This keeps running if you close it — records appear in the list as they are read.</div>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={() => api.delete(`/invoices/import/${job.id}`).catch(() => {})}>Stop</button>
          </div>
        )}

        {failed && <div className="alert alert-error"><span className="alert-icon">✕</span>{job.error || 'The import was stopped.'}</div>}

        {done && r && (
          <div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              {summary(r).map(t => (
                <div key={t.label} style={{ flex: 1, minWidth: 120, background: 'var(--bg-secondary)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: t.tone }}>{t.n}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.label}</div>
                </div>
              ))}
            </div>
            {failures(r).map((x, i) => (
              <div key={`${x.file}-${x.row ?? i}`} style={{ fontSize: 12, padding: '5px 0', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--danger)' }}>✕</span>
                <span style={{ flex: 1 }}>{x.file}{x.row ? ` · row ${x.row}` : ''}</span>
                <span style={{ color: 'var(--text-muted)' }}>{x.error}</span>
              </div>
            ))}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} onClick={onClose}>Done</button>
          </div>
        )}
    </Modal>
  );
}
