import { useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start at the route AFTER it.
// Writing '/api/receipts' would request '/api/api/receipts' and 404.
import { api } from '../../api/client';
import { prepareReceipt, blobToBase64, humanSize, ACCEPT_ATTR } from './receipt-upload';
import PhonePairingModal from './PhonePairingModal';

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
          {busy ? 'Uploading…' : '+ Add receipt'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setPairing(true)}
          style={{ whiteSpace: 'nowrap' }}
          title="Scan a code to photograph receipts with your phone"
        >
          📷 Use my phone
        </button>
      </div>

      {note && !error && (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{note}</span>
      )}
      {error && (
        <span style={{ fontSize: 10.5, color: 'var(--danger)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{error}</span>
      )}

      {pairing && (
        <PhonePairingModal onClose={() => setPairing(false)} onArrived={onUploaded} />
      )}
    </div>
  );
}
