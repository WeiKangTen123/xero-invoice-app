import { useRef, useState } from 'react';
import { api } from '../../api/client';
import ImportDialog, { encodeFiles } from '../intake/ImportDialog';

// Adding bills by hand. Until now a bill could only arrive by email; these are
// the other two ways in — one PDF straight to the list, or several (PDFs or a
// zip of them) as a background import with progress.
//
// Nothing here talks to Xero. An uploaded bill is stored for review and never
// posts on its own, whatever the auto-process setting — that rule lives on the
// server (intake/profiles.js), not in this component.

const ACCEPT = 'application/pdf,.pdf,application/zip,.zip';
const isPdf  = f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const isZip  = f => /\.zip$/i.test(f.name) || /zip/.test(f.type);
const classify = f => (isPdf(f) ? 'pdf' : isZip(f) ? 'zip' : null);

export const billImportProps = {
  title: 'Import bills',
  subtitle: 'Several PDFs, or a zip of them. Each is read and stored for your review.',
  accept: ACCEPT,
  hint: 'PDF files, or one or more .zip archives of PDFs',
  classify,
  buildBody: async files => ({ pdfs: await encodeFiles(files.filter(isPdf)), archives: await encodeFiles(files.filter(isZip)), label: files[0]?.name }),
  runningLabel: 'Reading bills',
  summary: r => [
    { n: r.created?.length || 0,    label: 'stored for review',     tone: 'var(--success)' },
    { n: r.duplicates?.length || 0, label: 'already in the system', tone: 'var(--warning)' },
    { n: (r.rejected?.length || 0) + (r.failed?.length || 0), label: 'could not be read', tone: 'var(--danger)' },
  ],
  failures: r => [...(r.rejected || []), ...(r.failed || [])],
};

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
    const other = files.filter(f => !classify(f));
    if (other.length) { setError(`${other.map(f => f.name).join(', ')} — bills are added as PDF files (or a zip of PDFs).`); return; }

    // One PDF goes straight in. More than one, or any zip, is a background job.
    if (pdfs.length === 1 && !zips.length) {
      setBusy(true);
      try {
        const [{ name, data }] = await encodeFiles(pdfs);
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
      const res = await api.post('/invoices/import', await billImportProps.buildBody(files));
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
      {importing && <ImportDialog {...billImportProps} initialJobId={jobId} onClose={() => setImporting(false)} onImported={onUploaded} />}
    </div>
  );
}
