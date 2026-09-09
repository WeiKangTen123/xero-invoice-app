import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start after it.
import { api } from '../../api/client';

// Importing a batch expense claim: a zip of receipts plus the claim form.
//
// The import is a background job, so this uploads, then polls. Closing the panel
// does not stop it — which is the point, since a large claim takes minutes.

const POLL_MS = 1500;
const ACCEPT = '.zip,.xlsx,.xls,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const STAGES = [
  ['unpacking',        'Unpacking archives'],
  ['reading form',     'Reading the claim form'],
  ['reading receipts', 'Reading receipts'],
  ['matching',         'Matching receipts to claim lines'],
  ['categorising',     'Suggesting categories'],
  ['saving',           'Saving claims'],
];
const stageIndex = stage => {
  const i = STAGES.findIndex(([k]) => k === stage);
  if (i >= 0) return i;
  return ['unpacked', 'form read'].includes(stage) ? 1 : (stage === 'done' ? STAGES.length : -1);
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
}

export default function ClaimImport({ onClose, onImported, initialJobId = null }) {
  const fileRef = useRef(null);
  const [files, setFiles]   = useState([]);
  const [job, setJob]       = useState(initialJobId ? { id: initialJobId, stage: 'reading receipts' } : null);
  const [error, setError]   = useState('');
  const [starting, setStart] = useState(false);

  useEffect(() => {
    if (initialJobId) {
      api.get(`/claims/import/${initialJobId}`)
        .then(res => setJob(res))
        .catch(err => setError(err.message || 'Could not load import job'));
    }
  }, [initialJobId]);

  const archives = files.filter(f => /\.zip$/i.test(f.name));
  const forms    = files.filter(f => /\.xlsx?$/i.test(f.name));

  // Poll only while the job is actually running.
  useEffect(() => {
    if (!job?.id || ['done', 'failed', 'cancelled'].includes(job.stage)) return undefined;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const next = await api.get(`/claims/import/${job.id}`);
        if (stop) return;
        setJob(next);
        if (next.stage === 'done') onImported?.();
      } catch { /* transient — the next tick retries */ }
    }, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [job?.id, job?.stage, onImported]);

  async function start() {
    setStart(true); setError('');
    try {
      const encode = async list => Promise.all(list.map(async f => ({ name: f.name, data: await fileToBase64(f) })));
      const res = await api.post('/claims/import', {
        archives: await encode(archives),
        forms:    await encode(forms),
        label:    forms[0]?.name || archives[0]?.name || 'Expense claim',
      });
      setJob({ id: res.jobId, stage: res.stage, receiptsRead: 0, receiptsTotal: 0 });
    } catch (err) {
      setError(err.message || 'Could not start the import');
    } finally { setStart(false); }
  }

  const done   = job?.stage === 'done';
  const failed = job?.stage === 'failed';
  const active = job && !done && !failed && job.stage !== 'cancelled';
  const s = job?.result?.summary;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeIn 0.15s ease' }}
         onClick={e => { if (e.target === e.currentTarget && !active) onClose(); }}>
      <div className="card" style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto',
                                     borderRadius: 18, boxShadow: 'var(--shadow-lg)', animation: 'scaleIn 0.2s ease' }}>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Import an expense claim</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>
              A zip of receipts and the claim form, as they arrive by email.
            </div>
          </div>
          <button onClick={onClose} disabled={active} aria-label="Close"
                  style={{ background: 'none', border: 'none', cursor: active ? 'not-allowed' : 'pointer',
                           color: 'var(--text-muted)', fontSize: 22, lineHeight: 1, opacity: active ? 0.4 : 1 }}>×</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 12 }}><span className="alert-icon">✕</span>{error}</div>}

        {/* ── Pick the files ────────────────────────────────────────────── */}
        {!job && (
          <>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple style={{ display: 'none' }}
                   onChange={e => setFiles(Array.from(e.target.files || []))} />
            <div onClick={() => fileRef.current?.click()}
                 style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '26px 18px',
                          textAlign: 'center', cursor: 'pointer', marginBottom: 14 }}>
              <div style={{ fontSize: 22, opacity: 0.5 }}>🗂</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>Choose the claim files</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                One or more .zip archives, plus the .xlsx claim form
              </div>
            </div>

            {files.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                {files.map(f => (
                  <div key={f.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                    <span>{/\.zip$/i.test(f.name) ? '🗜' : '📊'} {f.name}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{Math.round(f.size / 1024)} KB</span>
                  </div>
                ))}
                {/* Reading receipts costs a model call each, so the size of the
                    job is stated before anyone commits to it. */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
                  {archives.length} archive{archives.length === 1 ? '' : 's'} · {forms.length} form{forms.length === 1 ? '' : 's'}.
                  Every receipt is read by AI, which takes a few seconds each — a large claim can take a couple of minutes.
                </div>
              </div>
            )}

            <button className="btn btn-primary" style={{ width: '100%' }}
                    disabled={!files.length || starting} onClick={start}>
              {starting ? <><span className="btn-spinner" /> Starting…</> : 'Import claim'}
            </button>
          </>
        )}

        {/* ── Progress ──────────────────────────────────────────────────── */}
        {active && (
          <div>
            {STAGES.map(([key, label], i) => {
              const at = stageIndex(job.stage);
              const state = i < at ? 'done' : i === at ? 'now' : 'todo';
              const isReading = key === 'reading receipts' && state !== 'todo';
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 12.5,
                                        color: state === 'todo' ? 'var(--text-muted)' : 'var(--text-secondary)' }}>
                  <span style={{ width: 14, color: state === 'done' ? 'var(--success)' : 'var(--accent)' }}>
                    {state === 'done' ? '✓' : state === 'now' ? '◍' : '·'}
                  </span>
                  <span style={{ flex: 1 }}>{label}</span>
                  {isReading && job.receiptsTotal > 0 && (
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>
                      {job.receiptsRead} / {job.receiptsTotal}
                    </span>
                  )}
                </div>
              );
            })}

            {job.receiptsTotal > 0 && (
              <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-hover)', overflow: 'hidden', margin: '12px 0 8px' }}>
                <div style={{ height: '100%', background: 'var(--accent)', borderRadius: 2, transition: 'width .3s ease',
                              width: `${Math.round((job.receiptsRead / job.receiptsTotal) * 100)}%` }} />
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              This keeps running if you close it — the claims appear in AR &amp; AP when it finishes.
            </div>
            <button className="btn btn-outline btn-sm" style={{ marginTop: 12 }}
                    onClick={() => api.delete(`/claims/import/${job.id}`).catch(() => {})}>
              Stop
            </button>
          </div>
        )}

        {failed && (
          <div className="alert alert-error"><span className="alert-icon">✕</span>{job.error || 'The import failed.'}</div>
        )}

        {/* ── Reconciliation ────────────────────────────────────────────── */}
        {done && s && (() => {
          const totalClaims = s.total || job.result?.created?.length || 0;
          const dupCount = (job.result?.duplicates?.length || 0) + (job.result?.suspectedDuplicates?.length || 0);
          return (
            <div>
              {/* "27 imported" is useless. What matters is which ones need a person. */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
                {[
                  { n: s.verified, label: 'matched and verified', tone: 'var(--success)' },
                  { n: dupCount, label: 'duplicates detected', tone: 'var(--danger)' },
                  { n: s.discrepancies, label: "amount doesn't match", tone: 'var(--danger)' },
                  { n: s.missingReceipts, label: 'no receipt found', tone: 'var(--warning)' },
                  { n: s.extraReceipts, label: job.rowsTotal > 0 ? 'receipt with no claim line' : 'receipts ready for review', tone: job.rowsTotal > 0 ? 'var(--warning)' : 'var(--success)' },
                  { n: s.unreadable, label: 'could not be read', tone: 'var(--text-muted)' },
                ].filter(x => x.n > 0).map(x => (
                  <div key={x.label} style={{ flex: '1 1 150px', background: 'var(--bg-secondary)', borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: x.tone, fontVariantNumeric: 'tabular-nums' }}>{x.n}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{x.label}</div>
                  </div>
                ))}
              </div>

              {dupCount > 0 && (
                <Section title="Duplicate receipts detected">
                  {[...(job.result.duplicates || []), ...(job.result.suspectedDuplicates || [])].map((d, i) => (
                    <Line key={d.id || i}
                          left={`Receipt #${String(d.id || '').slice(-6)} · ${d.why || 'Matches existing receipt'}`}
                          right={d.of ? `duplicate of #${String(d.of).slice(-6)}` : 'duplicate'}
                          tone="var(--danger)" />
                  ))}
                </Section>
              )}

              {job.result.discrepancies?.length > 0 && (
                <Section title="Amounts that don't match the receipt">
                  {job.result.discrepancies.map(d => (
                    <Line key={d.rowNo}
                          left={`Row ${d.rowNo} · ${d.description || ''}`}
                          right={`claimed ${d.claimed} · receipt ${d.onReceipt}`}
                          tone="var(--danger)" />
                  ))}
                </Section>
              )}

              {job.result.missingReceipts?.length > 0 && (
                <Section title="Claim lines with no receipt">
                  {job.result.missingReceipts.map(m => (
                    <Line key={m.rowNo} left={`Row ${m.rowNo} · ${m.description || ''}`} right={String(m.amount ?? '')} tone="var(--warning)" />
                  ))}
                </Section>
              )}

              {job.result.extraReceipts?.length > 0 && job.rowsTotal > 0 && (
                <Section title="Receipts with no claim line">
                  {job.result.extraReceipts.map(r => (
                    <Line key={r.file} left={r.file.split('/').pop()} right={`${r.merchant || '—'} ${r.total ?? ''}`} tone="var(--warning)" />
                  ))}
                </Section>
              )}

              {job.result.categoriesSuggested > 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '10px 0', lineHeight: 1.5 }}>
                  {job.result.categoriesSuggested} categor{job.result.categoriesSuggested === 1 ? 'y was' : 'ies were'} suggested
                  for lines the claimant left blank — marked as suggestions, not answers.
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={onClose}>
                  Open {totalClaims} claim{totalClaims === 1 ? '' : 's'}
                </button>
                {/* An import that went wrong should not need twenty-seven deletions. */}
                <button className="btn btn-outline"
                        onClick={async () => {
                          if (!confirm(`Remove all ${totalClaims} claims from this import?`)) return;
                          try { await api.delete(`/claims/group/${job.result.groupId}`); onImported?.(); onClose(); }
                          catch (err) { setError(err.message); }
                        }}>
                  Undo import
                </button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase',
                    color: 'var(--text-muted)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Line({ left, right, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12,
                  padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{left}</span>
      <span style={{ color: tone, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{right}</span>
    </div>
  );
}
