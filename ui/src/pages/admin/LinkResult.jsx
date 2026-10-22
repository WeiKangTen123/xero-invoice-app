import { useState, useRef } from 'react';
import { formatShortDateTime } from '../../utils/formatDate';
import { linkResult } from './users';

// What an invite or a reset link came to (admin/users.js linkResult): sent
// by email, or a link for the admin to pass on themselves. Shown in the
// Invite a user card after an invite, and in a dialog after New link or Send
// reset link. The link is in this component's props only: once Done closes
// it, the page has no copy, which is what "Shown once" means.
export default function LinkResult({ kind, answer, email, timeZone, extra, onDone }) {
  const inputRef = useRef(null);
  const [copied, setCopied] = useState('');
  const when = formatShortDateTime(answer?.expiresAt, timeZone);
  const r    = linkResult(kind, answer, email, when);

  // The clipboard is only there on https (or localhost), and the browser may
  // refuse it; then the link is selected, for the old copy command or for
  // Ctrl+C.
  async function copy() {
    try {
      await navigator.clipboard.writeText(r.link);
      setCopied('Copied');
    } catch (_) {
      const el = inputRef.current;
      el?.focus();
      el?.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
      setCopied(ok ? 'Copied' : 'Selected: press Ctrl+C to copy');
    }
  }

  return (
    <div>
      <div className={`alert ${r.ok ? 'alert-success' : 'alert-warning'}`} role="status">
        <span className="alert-icon">{r.ok ? '✓' : '⚠'}</span>
        <span style={{ lineHeight: 1.55 }}>{r.text}</span>
      </div>
      {extra && <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-4px 0 12px', lineHeight: 1.5 }}>{extra}</div>}

      {r.link && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              ref={inputRef}
              className="form-input"
              readOnly
              value={r.link}
              aria-label={kind === 'reset' ? `Reset link for ${email}` : `Invite link for ${email}`}
              onFocus={e => e.target.select()}
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: 12 }}
            />
            <button type="button" className="btn btn-outline btn-sm" onClick={copy} style={{ flexShrink: 0 }}>
              Copy link
            </button>
          </div>
          {copied && <div role="status" style={{ fontSize: 11.5, color: 'var(--success)', marginTop: 4 }}>{copied}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{r.note}</div>
        </div>
      )}

      <button type="button" className="btn btn-primary" onClick={onDone} style={{ width: '100%', justifyContent: 'center' }}>
        Done
      </button>
    </div>
  );
}
