import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { prepareReceipt, blobToBase64, humanSize, ACCEPT_ATTR } from '../components/receipts/receipt-upload';

// The page a phone lands on after scanning the QR code shown on the desktop.
//
// Deliberately outside the auth guard: the pairing token in the URL is the only
// credential, which is the entire point — nobody types a password on a phone to
// photograph a receipt. That token grants upload and nothing else, so this page
// can never list, read or delete anything.
export default function Capture() {
  const { token } = useParams();
  const fileRef = useRef(null);
  const [state, setState]   = useState('checking'); // checking | ready | expired
  const [busy, setBusy]     = useState(false);
  const [sent, setSent]     = useState([]);
  const [error, setError]   = useState('');
  const [usesLeft, setUses] = useState(null);

  // Validate before showing a camera button, so an expired link says so instead
  // of failing after the user has taken a photo.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/receipts/capture/${encodeURIComponent(token)}`)
      .then(r => r.json().then(b => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (cancelled) return;
        if (!ok || !b.ok) { setState('expired'); setError(b.error || 'This link is no longer valid.'); return; }
        setState('ready');
        setUses(b.usesLeft);
      })
      .catch(() => { if (!cancelled) { setState('expired'); setError('Could not reach the server.'); } });
    return () => { cancelled = true; };
  }, [token]);

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    setBusy(true);
    setError('');

    for (const file of list) {
      try {
        const { blob, mime, originalBytes, bytes } = await prepareReceipt(file);
        const data = await blobToBase64(blob);
        const res  = await fetch(`/api/receipts/capture/${encodeURIComponent(token)}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ mime, data, filename: file.name }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Upload failed');
        setSent(s => [...s, { name: file.name, from: originalBytes, to: bytes }]);
        setUses(n => (n === null ? null : Math.max(0, n - 1)));
      } catch (err) {
        setError(err.message);
      }
    }

    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  const wrap = { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center',
                 justifyContent: 'center', padding: 24, gap: 18, textAlign: 'center' };

  if (state === 'checking') {
    return <div style={wrap}><span style={{ color: 'var(--text-muted)', fontSize: 14 }}>Checking link…</span></div>;
  }

  if (state === 'expired') {
    return (
      <div style={wrap}>
        <div style={{ fontSize: 40 }}>⏱</div>
        <h2 style={{ fontSize: 18, margin: 0 }}>Link expired</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, maxWidth: 320, lineHeight: 1.6, margin: 0 }}>{error}</p>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <h2 style={{ fontSize: 19, margin: 0 }}>Add a receipt</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, maxWidth: 320, lineHeight: 1.6, margin: 0 }}>
        Photograph the receipt. It appears on your computer straight away.
      </p>

      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ATTR}
        // Opens the rear camera directly rather than a file browser. Removing
        // this attribute is what turns it back into a picker, which is what the
        // desktop wants and the phone does not.
        capture="environment"
        multiple
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />

      <button
        className="btn"
        disabled={busy || usesLeft === 0}
        onClick={() => fileRef.current?.click()}
        // Large tap target: this is the only control on the page and it is being
        // used one-handed, probably standing up.
        style={{ fontSize: 17, padding: '18px 34px', borderRadius: 14, minWidth: 240 }}
      >
        {busy ? 'Sending…' : '📷  Take photo'}
      </button>

      {usesLeft === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, maxWidth: 300, lineHeight: 1.6 }}>
          This link has reached its limit. Show a new QR code on your computer to carry on.
        </p>
      )}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 12.5, maxWidth: 320, lineHeight: 1.6 }}>{error}</p>
      )}

      {sent.length > 0 && (
        <div style={{ marginTop: 6, width: '100%', maxWidth: 320 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
            Sent ({sent.length})
          </div>
          {sent.map((s, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, padding: '7px 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--success)' }}>✓ {s.name || `Photo ${i + 1}`}</span>
              <span style={{ color: 'var(--text-muted)' }}>{humanSize(s.to)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
