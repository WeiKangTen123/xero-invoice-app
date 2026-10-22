import { useState } from 'react';
import { formatDateTime } from '../../utils/formatDate';
import { recoveryList, copyAllText, recoveryCodesText, RECOVERY_FILE_NAME } from './two-step';

// Copies text: the clipboard where the browser allows it (https or
// localhost), otherwise the old copy command on a hidden box. True when it
// worked.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_e) { ok = false; }
    el.remove();
    return ok;
  }
}

// The ten recovery codes, shown once: when 2-step sign-in is turned on, and
// when new ones are made. The server keeps only their hashes, so once Done
// is pressed they are gone from the page; Done stays off until the box says
// they were saved. Copy all copies them a line each; Download .txt saves
// them with what they are for (two-step.js recoveryCodesText).
export default function RecoveryCodes({ codes, email, timeZone, onDone }) {
  const [saved, setSaved] = useState(false);
  const [note,  setNote]  = useState('');
  const list = recoveryList(codes);

  async function copyAll() {
    setNote(await copyText(copyAllText(list)) ? 'Copied' : 'Could not copy: select the codes and press Ctrl+C');
  }

  function download() {
    const made = formatDateTime(new Date().toISOString(), timeZone);
    const blob = new Blob([recoveryCodesText(list, { email, made })], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = RECOVERY_FILE_NAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote('Downloaded');
  }

  return (
    <div>
      <div className="alert alert-warning" role="status" style={{ marginBottom: 12 }}>
        <span className="alert-icon">⚠</span>
        <span style={{ lineHeight: 1.55 }}>
          Save these recovery codes now: they are not shown again. If you lose your phone, each one signs you in once in place of a code from the app.
        </span>
      </div>

      <ol aria-label="Recovery codes" style={{
        listStyle: 'none', margin: 0, padding: '14px 16px',
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px 18px',
        fontFamily: 'monospace', fontSize: 14.5, letterSpacing: '0.04em',
        background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10,
      }}>
        {list.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}
      </ol>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button type="button" className="btn btn-outline btn-sm" onClick={copyAll}>Copy all</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={download}>Download .txt</button>
        {note && <span role="status" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{note}</span>}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />
        I have saved these codes
      </label>

      <button type="button" className="btn btn-primary" onClick={onDone} disabled={!saved} style={{ marginTop: 12 }}>
        Done
      </button>
    </div>
  );
}
