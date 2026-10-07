import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start at the route AFTER it.
// Writing '/api/receipts' would request '/api/api/receipts' and 404.
import { api } from '../../api/client';
import { prepareReceipt, blobToBase64, humanSize, ACCEPT_ATTR } from './receipt-upload';
import PhonePairingModal from './PhonePairingModal';
import ClaimImport from './ClaimImport';
import AllowanceClaimModal from './AllowanceClaimModal';
import { ALLOWANCE_KINDS } from './allowance';

// Add-receipt controls for AR & AP. Expense claims are the only document type
// the user creates by hand — bills and invoices arrive by email on their own —
// so this is the one place in the list that needs an input affordance.
//
// Nothing here talks to Xero. An uploaded receipt becomes a local record for the
// user to review.
export default function ReceiptUpload({ onUploaded }) {
  const fileRef = useRef(null);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [note, setNote]     = useState('');
  const [pairing, setPairing] = useState(false);
  const [importing, setImporting] = useState(false);
  // Mileage and per diem are offered only once a rate is set for them in
  // Setup; null until asked, and a failed ask simply leaves them out.
  const [allowances, setAllowances] = useState(null);
  const [adding, setAdding] = useState(null);   // 'mileage' | 'per_diem' | null

  useEffect(() => {
    let active = true;
    api.get('/claims/allowance/settings')
      .then(d => { if (active) setAllowances(d); })
      .catch(() => { if (active) setAllowances(null); });
    return () => { active = false; };
  }, []);

  // A possible duplicate is saved anyway (it is only a warning), so say so
  // here, where the person who typed it is looking.
  function allowanceAdded(res) {
    setError('');
    setNote(res?.duplicate
      ? `Added, but it matches ${res.duplicate.invoiceNumber || 'another claim'}, so it is marked as a possible duplicate. Check it before approving.`
      : '');
    if (onUploaded) onUploaded();
  }

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;

    setBusy(true);
    setError('');
    setNote('');
    const failures = [];
    let ok = 0;

    for (const file of list) {
      try {
        const { blob, mime, originalBytes, bytes } = await prepareReceipt(file);
        const data = await blobToBase64(blob);
        await api.post('/receipts', { mime, data, filename: file.name, source: 'upload' });
        ok++;
        // Worth saying out loud: a 9MB photo becoming 700KB is the difference
        // between Xero accepting the attachment and rejecting it.
        if (bytes < originalBytes) {
          setNote(`Compressed ${humanSize(originalBytes)} → ${humanSize(bytes)} to fit Xero's 3MB attachment limit.`);
        }
      } catch (err) {
        failures.push(`${file.name}: ${err.message}`);
      }
    }

    setBusy(false);
    if (failures.length) setError(failures.join(' · '));
    if (ok && onUploaded) onUploaded();
    if (fileRef.current) fileRef.current.value = '';  // let the same file be picked again
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.3)', whiteSpace: 'nowrap' }}
        >
          {busy ? 'Uploading…' : '+ Add claim'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setImporting(true)}
          style={{ whiteSpace: 'nowrap' }}
          title="Import a zip of receipts with its claim form, as emailed"
        >
          🗂 Import claim
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setPairing(true)}
          style={{ whiteSpace: 'nowrap' }}
          title="Scan a code to photograph expense claims with your phone"
        >
          📷 Use my phone
        </button>
        {Object.entries(ALLOWANCE_KINDS).filter(([kind]) => allowances?.[kind]?.enabled).map(([kind, meta]) => (
          <button
            key={kind}
            className="btn btn-sm"
            onClick={() => setAdding(kind)}
            style={{ whiteSpace: 'nowrap' }}
            title={`A ${meta.label.toLowerCase()} claim, no receipt needed: priced at the rate in Setup`}
          >
            {meta.icon} Add {meta.label.toLowerCase()}
          </button>
        ))}
      </div>

      {note && !error && (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{note}</span>
      )}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.25)',
          borderRadius: 8,
          padding: '7px 12px',
          fontSize: 12,
          color: 'var(--danger)',
          maxWidth: 360,
          textAlign: 'left',
          lineHeight: 1.45,
          marginTop: 2,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 6,
        }}>
          <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span>
          <span>{error}</span>
        </div>
      )}

      {pairing && (
        <PhonePairingModal onClose={() => setPairing(false)} onArrived={onUploaded} />
      )}

      {importing && (
        <ClaimImport onClose={() => setImporting(false)} onImported={onUploaded} />
      )}

      {adding && allowances && (
        <AllowanceClaimModal kind={adding} settings={allowances} onClose={() => setAdding(null)} onAdded={allowanceAdded} />
      )}
    </div>
  );
}
