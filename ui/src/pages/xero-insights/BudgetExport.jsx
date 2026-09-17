import { useState } from 'react';
import { api } from '../../api/client';

// Export buttons for the two budget reports.
//
// Two steps, because a browser cannot put an Authorization header on a plain
// navigation: ask the API (with the JWT) for a short-lived signed URL, then open
// that. The tab is opened synchronously inside the click and its location set
// afterwards — Safari treats a window.open that happens after an await as a
// popup rather than a user action and blocks it, which is the whole reason this
// is not simply `window.open(await ...)`.
//
// PDF opens inline, so on a phone it lands in the system viewer where pinching
// and panning already work — which is the honest answer for a table that is
// three and a half screens wide. The workbook is there because a spreadsheet is
// usually what an accountant actually wanted.
export function BudgetExport({ kind, month, disabled }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function open(format) {
    setError('');
    setBusy(format);
    const tab = window.open('', '_blank');
    try {
      const q = new URLSearchParams({ kind, format });
      if (month) q.set('month', month);
      const { url } = await api.get(`/xero-reports/budget/export-url?${q.toString()}`);
      if (tab) tab.location = url;
      else window.location.assign(url); // popup blocked — navigate instead of failing silently
    } catch (err) {
      if (tab) tab.close();
      setError(err.message || 'Could not build the export');
    } finally {
      setBusy('');
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-outline btn-sm" disabled={disabled || !!busy} onClick={() => open('pdf')}>
        {busy === 'pdf' ? <span className="btn-spinner" /> : '⤓'} PDF
      </button>
      <button className="btn btn-outline btn-sm" disabled={disabled || !!busy} onClick={() => open('xlsx')}>
        {busy === 'xlsx' ? <span className="btn-spinner" /> : '⤓'} Excel
      </button>
      {error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{error}</span>}
    </div>
  );
}
