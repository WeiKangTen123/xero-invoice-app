import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { blobToBase64, humanSize } from '../receipts/receipt-upload';

// Adding bills by hand. Until now a bill could only arrive by email; these are
// the other two ways in — one PDF straight to the list, or several (PDFs or a
// zip of them) as a background import with progress.
//
// Nothing here talks to Xero. An uploaded bill is stored for review and never
// posts on its own, whatever the auto-process setting — that rule lives on the
// server (intake/profiles.js), not in this component.

const POLL_MS = 1500;
const ACCEPT  = 'application/pdf,.pdf,application/zip,.zip';
const isPdf   = f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const isZip   = f => /\.zip$/i.test(f.name) || /zip/.test(f.type);

async function encode(files) {
  return Promise.all(files.map(async f => ({ name: f.name, data: await blobToBase64(f) })));
}

export default function BillIntake({ onUploaded }) {
  const fileRef = useRef(null);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [note, setNote]   = useState('');
  const [importing, setImporting] = useState(false);
  const [jobId, setJobId] = useState(null);

  async function handleFiles(list) {
    const files = Array.from(list || []);
    if (fileRef.current) fileRef.current.value = '';
    if (!files.length) return;
    setError(''); setNote('');
    const pdfs = files.filter(isPdf), zips = files.filter(isZip);
    const other = files.filter(f => !isPdf(f) && !isZip(f));
    if (other.length) { setError(`${other.map(f => f.name).join(', ')} — bills are added as PDF files (or a zip of PDFs).`); return; }

    // One PDF goes straight in. More than one, or any zip, is a background job.
    if (pdfs.length === 1 && !zips.length) {
      setBusy(true);
      try {
        const [{ name, data }] = await encode(pdfs);
        const res = await api.post('/invoices', { name, data });
        const n = res.records?.length || 1;
        setNote(n > 1 ? `${name}: ${n} bills read from one PDF — stored for review.` : `${name} stored for review.`);
        onUploaded?.();
      } catch (err) {
        setError(err.message || 'Upload failed');
      } finally { setBusy(false); }
      return;
    }
    setBusy(true);
    try {
      const res = await api.post('/invoices/import', { pdfs: await encode(pdfs), archives: await encode(zips) });
      setJobId(res.jobId); setImporting(true);
    } catch (err) {
      setError(err.message || 'Import could not start');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
      <input ref={fileRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={e => handleFiles(e.target.files)} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}
                style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.3)', whiteSpace: 'nowrap' }}
                title="Upload a supplier's bill as a PDF">
          {busy ? 'Uploading…' : '+ Add bill'}
        </button>
        <button className="btn btn-sm" onClick={() => { setJobId(null); setImporting(true); }} style={{ whiteSpace: 'nowrap' }}
                title="Import several bills — PDFs, or a zip of them — in the background">
          🗂 Import bills
        </button>
      </div>
      {note && !error && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{note}</span>}
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, padding: '7px 12px',
                      fontSize: 12, color: 'var(--danger)', maxWidth: 360, textAlign: 'left', lineHeight: 1.45, display: 'flex', gap: 6 }}>
          <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span><span>{error}</span>
        </div>
      )}
      {importing && (
        <BillImport initialJobId={jobId} onClose={() => setImporting(false)} onImported={onUploaded} />
      )}
    </div>
  );
}

// The import dialog: pick files, watch the job, read the outcome per file.
export function BillImport({ onClose, onImported, initialJobId = null }) {
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

  const pdfs = files.filter(isPdf), zips = files.filter(isZip);
  const unsupported = files.filter(f => !isPdf(f) && !isZip(f));
  const sendable = pdfs.length + zips.length;

  async function start() {
    setStarting(true); setError('');
    try {
      const res = await api.post('/invoices/import', { pdfs: await encode(pdfs), archives: await encode(zips), label: files[0]?.name });
      setJob({ id: res.jobId, stage: res.stage, filesTotal: 0, filesRead: 0 });
    } catch (err) {
      setError(err.message || 'Could not start the import');
    } finally { setStarting(false); }
  }

  const r = job?.result;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeIn 0.15s ease' }}
         onClick={e => { if (e.target === e.currentTarget && !active) onClose(); }}>
      <div className="card" style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', borderRadius: 18, boxShadow: 'var(--shadow-lg)', animation: 'scaleIn 0.2s ease' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Import bills</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>Several PDFs, or a zip of them. Each is read and stored for your review.</div>
          </div>
          <button onClick={onClose} disabled={active} aria-label="Close"
                  style={{ background: 'none', border: 'none', cursor: active ? 'not-allowed' : 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1, opacity: active ? 0.4 : 1 }}>×</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span className="alert-icon">✕</span>{error}</div>}

        {!job && (
          <>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }} onChange={e => setFiles(Array.from(e.target.files || []))} />
            <div onClick={() => fileRef.current?.click()} style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '26px 18px', textAlign: 'center', cursor: 'pointer', marginBottom: 14 }}>
              <div style={{ fontSize: 22, opacity: 0.5 }}>🗂</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>Choose the bills</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>PDF files, or one or more .zip archives of PDFs</div>
            </div>
            {files.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {files.map(f => {
                  const bad = (!isPdf(f) && !isZip(f)) || f.size === 0;
                  return (
                    <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '6px 0', borderTop: '1px solid var(--border)', opacity: bad ? 0.6 : 1 }}>
                      <span style={{ color: bad ? 'var(--danger)' : undefined }}>{bad ? '⚠' : isZip(f) ? '🗜' : '📄'} {f.name}</span>
                      <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{f.size === 0 ? 'empty' : humanSize(f.size)}</span>
                    </div>
                  );
                })}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                  {pdfs.length} PDF{pdfs.length === 1 ? '' : 's'} · {zips.length} archive{zips.length === 1 ? '' : 's'}.
                  Each bill is read by AI, a few seconds each — a large batch can take a couple of minutes.
                </div>
                {unsupported.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 8 }}>⚠ {unsupported.map(f => f.name).join(', ')} will not be sent — only PDFs and zips are read.</div>
                )}
              </div>
            )}
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={!sendable || starting} onClick={start}>
              {starting ? <><span className="btn-spinner" /> Starting…</> : sendable ? 'Import bills' : 'Attach PDFs or a zip to continue'}
            </button>
          </>
        )}

        {active && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-secondary)', padding: '7px 0' }}>
              <span>{job.stage === 'queued' ? 'Waiting to start' : 'Reading bills'}</span>
              {job.filesTotal > 0 && <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{job.filesRead} / {job.filesTotal}</span>}
            </div>
            {job.filesTotal > 0 && (
              <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-hover)', overflow: 'hidden', margin: '8px 0' }}>
                <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width .3s ease', width: `${Math.round((job.filesRead / job.filesTotal) * 100)}%` }} />
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>This keeps running if you close it — the bills appear in the list as they are read.</div>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={() => api.delete(`/invoices/import/${job.id}`).catch(() => {})}>Stop</button>
          </div>
        )}

        {failed && <div className="alert alert-error"><span className="alert-icon">✕</span>{job.error || 'The import was stopped.'}</div>}

        {done && r && (
          <div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              {[
                { n: r.created?.length || 0,    label: 'stored for review', tone: 'var(--success)' },
                { n: r.duplicates?.length || 0, label: 'already in the system', tone: 'var(--warning)' },
                { n: (r.rejected?.length || 0) + (r.failed?.length || 0), label: 'could not be read', tone: 'var(--danger)' },
              ].map(t => (
                <div key={t.label} style={{ flex: 1, minWidth: 120, background: 'var(--bg-secondary)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: t.tone }}>{t.n}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.label}</div>
                </div>
              ))}
            </div>
            {[...(r.rejected || []), ...(r.failed || [])].map(x => (
              <div key={x.file} style={{ fontSize: 12, padding: '5px 0', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--danger)' }}>✕</span><span style={{ flex: 1 }}>{x.file}</span><span style={{ color: 'var(--text-muted)' }}>{x.error}</span>
              </div>
            ))}
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
