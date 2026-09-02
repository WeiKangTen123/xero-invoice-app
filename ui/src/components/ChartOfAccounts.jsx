import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

// The chart of accounts, as reference rather than analysis.
//
// It lives in Settings because the question it answers is "is my setup right?" —
// checking that the codes the account picker offers are the ones you expect.
// A list of account codes tells you nothing you would act on about the business,
// which is why it is not a dashboard tab.
//
// The same /xero-reports/accounts route also backs AccountCodeSelect, so this is
// a second reader of data the app already fetches, not a new cost.
export default function ChartOfAccounts({ tenantId }) {
  const [state, setState]   = useState({ status: 'idle', data: [], error: '' });
  const [search, setSearch] = useState('');

  // Fetched when this section is rendered, not on every Settings visit.
  useEffect(() => {
    let active = true;
    setState(s => ({ ...s, status: 'loading' }));
    api.get(`/xero-reports/accounts${tenantId ? `?tenantId=${tenantId}` : ''}`)
      .then(d => { if (active) setState({ status: 'done', data: d.accounts || [], error: '' }); })
      .catch(err => { if (active) setState({ status: 'done', data: [], error: err.message }); });
    return () => { active = false; };
  }, [tenantId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return state.data;
    return state.data.filter(a =>
      (a.code || '').toLowerCase().includes(q) ||
      (a.name || '').toLowerCase().includes(q) ||
      (a.type || '').toLowerCase().includes(q));
  }, [state.data, search]);

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Chart of Accounts</div>
        <input
          type="text"
          className="form-input"
          placeholder="Search by code, name, or type..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 240 }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
        Read live from Xero. These are the codes offered when you assign an account to a bill
        or receipt — check here if the picker is missing something you expect.
      </div>

      {state.status !== 'done' ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
      ) : state.error ? (
        <div className="alert alert-error"><span className="alert-icon">✕</span>{state.error}</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: '30px 0' }}>
          <div className="empty-state-icon">📋</div>
          <div>{state.data.length ? 'No accounts match' : 'No accounts found — is Xero connected?'}</div>
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                <th style={{ padding: '6px 10px' }}>Code</th><th style={{ padding: '6px 10px' }}>Name</th>
                <th style={{ padding: '6px 10px' }}>Type</th><th style={{ padding: '6px 10px' }}>Tax Type</th>
                <th style={{ padding: '6px 10px' }}>Status</th>
              </tr></thead>
              <tbody>{filtered.map(a => (
                <tr key={a.accountId} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '9px 10px' }}>{a.code || '—'}</td>
                  <td style={{ padding: '9px 10px' }}>{a.name}</td>
                  <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.type}</td>
                  <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.taxType || '—'}</td>
                  <td style={{ padding: '9px 10px' }}>
                    <span className={`badge ${a.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{a.status || '—'}</span>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 10 }}>
            {filtered.length} of {state.data.length} accounts · read-only, managed in Xero
          </div>
        </>
      )}
    </div>
  );
}
