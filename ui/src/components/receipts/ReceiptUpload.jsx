import { useEffect, useRef, useState } from 'react';
// api/client prepends BASE = '/api', so paths here start at the route AFTER it.
// Writing '/api/receipts' would request '/api/api/receipts' and 404.
import { api } from '../../api/client';
import { prepareReceipt, blobToBase64, humanSize, ACCEPT_ATTR } from './receipt-upload';

// Add-receipt control for AR & AP. Expense claims are the only document type the
// user creates by hand — bills and invoices arrive by email on their own — so
// this is the one place in the list that needs an input affordance.
//
// Nothing here talks to Xero. An uploaded receipt becomes a local record for the
// user to review.
export default function ReceiptUpload({ onUploaded }) {
  const fileRef = useRef(null);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [note, setNote]   = useState('');
  const [pair, setPair]   = useState(null);   // { token, qrSvg, url }
  const [arrived, setArrived] = useState(0);
  const [secsLeft, setSecs]   = useState(0);

  // Poll the pairing while the dialog is open so a photo taken on the phone
  // appears here without the user touching anything. Polling the PAIRING rather
  // than the invoice list keeps this to one small request every few seconds.
  useEffect(() => {
    if (!pair) return undefined;
    let stop = false;
    const timer = setInterval(async () => {
      try {
        const s = await api.get(`/receipts/pair/${pair.token}`);
        if (stop) return;
        if (!s.alive) { setPair(null); return; }
        setSecs(Math.max(0, Math.round(s.expiresInMs / 1000)));
        if (s.uploads > arrived) {
          setArrived(s.uploads);
          if (onUploaded) onUploaded();      // pull the new row into the list
        }
      } catch { /* a transient failure just means we try again in 3s */ }
    }, 3000);
    return () => { stop = true; clearInterval(timer); };
  }, [pair, arrived, onUploaded]);

  // Revoking on close means a QR that was on screen stops working the moment
  // the user is done with it, rather than lingering for the rest of its TTL.
  async function closePairing() {
    const token = pair?.token;
    setPair(null);
    setArrived(0);
    if (token) { try { await api.delete(`/receipts/pair/${token}`); } catch { /* it expires anyway */ } }
  }

  async function startPairing() {
    setError('');
    try {
      const res = await api.post('/receipts/pair', {});
      setPair(res);
      setArrived(0);
      setSecs(Math.round(res.expiresInMs / 1000));
    } catch (err) {
      setError(err.message || 'Could not create a pairing code');
    }
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
          {busy ? 'Uploading…' : '+ Add receipt'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => (pair ? closePairing() : startPairing())}
          style={{ whiteSpace: 'nowrap' }}
          title="Scan a code to photograph receipts with your phone"
        >
          {pair ? 'Close' : '📷 Use my phone'}
        </button>
      </div>

      {pair && (
        <div className="card" style={{ padding: 16, marginTop: 4, width: 250, textAlign: 'center' }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, marginBottom: 10 }}>Scan with your phone</div>
          {/* Server-rendered SVG: scales to any size without blurring, and keeps
              the QR library out of this bundle. */}
          <div
            style={{ background: '#fff', padding: 8, borderRadius: 8, lineHeight: 0 }}
            dangerouslySetInnerHTML={{ __html: pair.qrSvg }}
          />
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 }}>
            {secsLeft > 0
              ? `Expires in ${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`
              : 'Expired — close and try again'}
          </div>
          <div style={{ fontSize: 11, marginTop: 6, color: arrived ? 'var(--success)' : 'var(--text-muted)' }}>
            {arrived
              ? `✓ ${arrived} receipt${arrived === 1 ? '' : 's'} received`
              : 'Waiting for a photo…'}
          </div>
          <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            No login needed on the phone. The link uploads only — it cannot read your data.
          </div>
        </div>
      )}

      {note && !error && (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{note}</span>
      )}
      {error && (
        <span style={{ fontSize: 10.5, color: 'var(--danger)', maxWidth: 340, textAlign: 'right', lineHeight: 1.45 }}>{error}</span>
      )}
    </div>
  );
}
