import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { fmtMoney } from '../../utils/format';

// The device-pairing pattern people already know from WhatsApp Web and banking
// apps: a big scannable code, numbered steps, and visible confirmation.
//
// The thumbnails are the point. A counter saying "3 received" makes you look
// away to the table to check it really worked; seeing the photo you just took
// appear is the confirmation itself.
//
// Blocking the page costs nothing here — while pairing you are holding a phone,
// not using the desktop.
export default function PhonePairingModal({ onClose, onArrived }) {
  const [pair, setPair]       = useState(null);
  const [receipts, setRcpts]  = useState([]);
  const [secsLeft, setSecs]   = useState(0);
  const [spent, setSpent]     = useState(false);
  const [error, setError]     = useState('');

  // Mint the pairing once, on open.
  useEffect(() => {
    let active = true;
    api.post('/receipts/pair', {})
      .then(res => { if (active) { setPair(res); setSecs(Math.round(res.expiresInMs / 1000)); } })
      .catch(err => { if (active) setError(err.message || 'Could not create a pairing code'); });
    return () => { active = false; };
  }, []);

  // Poll for arrivals. One request carries the countdown, the count and the
  // photos, so the panel needs nothing else.
  useEffect(() => {
    if (!pair) return undefined;
    let stop = false;

    async function poll() {
      try {
        const s = await api.get(`/receipts/pair/${pair.token}`);
        if (stop) return;
        setSecs(Math.max(0, Math.round(s.expiresInMs / 1000)));
        setSpent(!!s.spent);
        if (s.receipts) {
          // Parsed fields arrive over later polls, so replace wholesale rather
          // than appending — a row's merchant and total fill in as they are read.
          setRcpts(prev => {
            if (s.receipts.length !== prev.length) onArrived?.();
            return s.receipts;
          });
        }
      } catch { /* transient — the next tick tries again */ }
    }

    poll();
    const timer = setInterval(poll, 3000);
    return () => { stop = true; clearInterval(timer); };
  }, [pair, onArrived]);

  // Revoke on close so a code that was on screen dies immediately rather than
  // lingering for the rest of its ten minutes.
  async function close() {
    const token = pair?.token;
    onClose();
    if (token) { try { await api.delete(`/receipts/pair/${token}`); } catch { /* it expires anyway */ } }
  }

  const mmss = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, '0')}`;
  const expired = secsLeft <= 0 && !!pair;

  const steps = [
    'Open the camera app on your phone',
    'Point it at this code and tap the link',
    'Photograph your receipts — no login needed',
  ];

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
               display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeIn 0.15s ease' }}
      onClick={e => { if (e.target === e.currentTarget) close(); }}
    >
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 18,
                    padding: '26px 28px 22px', width: '100%', maxWidth: 430, boxShadow: 'var(--shadow-lg)',
                    animation: 'scaleIn 0.2s ease', maxHeight: '90vh', overflowY: 'auto' }}>

        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Scan with your phone</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
              Photograph receipts straight into this list.
            </div>
          </div>
          <button onClick={close} aria-label="Close"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1, padding: 2 }}>×</button>
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 14 }}><span className="alert-icon">✕</span>{error}</div>}

        {!pair && !error && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 240, gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
            <span style={{ width: 16, height: 16, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.65s linear infinite', display: 'inline-block' }} />
            Creating a code…
          </div>
        )}

        {pair && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
              <div style={{ background: '#fff', padding: 12, borderRadius: 12, lineHeight: 0,
                            // An expired code must not look scannable.
                            opacity: expired ? 0.25 : 1, transition: 'opacity .2s ease' }}
                   dangerouslySetInnerHTML={{ __html: pair.qrSvg }} />
            </div>

            <ol style={{ margin: '0 0 16px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((text, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  <span style={{ flexShrink: 0, width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-secondary)',
                                 color: 'var(--text-muted)', fontSize: 10.5, fontWeight: 700,
                                 display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                  {text}
                </li>
              ))}
            </ol>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                          padding: '10px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
              <span style={{ color: expired ? 'var(--danger)' : 'var(--text-muted)' }}>
                {expired ? 'Code expired' : `⏱ Expires in ${mmss}`}
              </span>
              <span style={{ color: receipts.length ? 'var(--success)' : 'var(--text-muted)' }}>
                {receipts.length
                  ? `✓ ${receipts.length} received`
                  : <><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', marginRight: 7, animation: 'pulse 1.4s ease-in-out infinite' }} />Waiting for a photo…</>}
              </span>
            </div>

            {receipts.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 12 }}>
                {receipts.map(r => (
                  <div key={r.id} style={{ width: 76 }}>
                    <div style={{ width: 76, height: 76, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <img src={`/api/receipts/${r.id}/image?token=${encodeURIComponent(r.imageToken)}`}
                           alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    {/* Fills in a poll or two later, once the image has been read. */}
                    <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.totalAmount ? fmtMoney(r.totalAmount, r.currency || '') : (r.vendorName || 'Reading…')}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {(expired || spent) && (
              <button className="btn btn-sm" onClick={close} style={{ marginTop: 14, width: '100%' }}>
                Done — close and show a new code if you need one
              </button>
            )}
          </>
        )}

        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 16, paddingTop: 12,
                      borderTop: '1px solid var(--border)', lineHeight: 1.55 }}>
          The link uploads only — it cannot read your data, and it stops working when you close this.
        </div>
      </div>
    </div>
  );
}
