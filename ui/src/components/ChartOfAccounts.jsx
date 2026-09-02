import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';

// The chart of accounts, as reference rather than analysis.
//
// It lives in Settings because the question it answers is "is my setup right?" —
// checking that the codes the account picker offers are the ones you expect.
// A list of account codes tells you nothing you would act on about the business,
// which is why it is not a dashboard tab.
//
// Three states, not two. The route returns { connected: false } as a 200 with no
// accounts key, so an empty list means EITHER "not connected" OR "connected to an
// empty organisation" — and those need different things said about them. Reading
// `connected` rather than inferring from an empty array is the difference between
// telling the user what to do and asking them a question we already know.
export default function ChartOfAccounts({ refreshKey = 0 }) {
  const [state, setState]   = useState({ status: 'loading', connected: null, accounts: [], tenants: [], activeTenantId: null, error: '' });
  const [search, setSearch] = useState('');
  const [pickedTenant, setPicked] = useState(null);

  // refreshKey changes whenever the Xero connection does. Without it, disconnecting
  // on this very page left the previous organisation's accounts sitting here
  // looking live — worse than showing nothing, because it invites coding a bill
  // against an account that no longer applies.
  useEffect(() => {
    let active = true;
    setState(s => ({ ...s, status: 'loading' }));
    const qs = pickedTenant ? `?tenantId=${encodeURIComponent(pickedTenant)}` : '';
    api.get(`/xero-reports/accounts${qs}`)
      .then(d => {
        if (!active) return;
        setState({
          status: 'done',
          connected: d.connected !== false,
          accounts: d.accounts || [],
          tenants: d.tenants || [],
          activeTenantId: d.activeTenantId || null,
          error: '',
        });
      })
      .catch(err => {
        if (active) setState({ status: 'done', connected: null, accounts: [], tenants: [], activeTenantId: null, error: err.message });
      });
    return () => { active = false; };
  }, [refreshKey, pickedTenant]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return state.accounts;
    return state.accounts.filter(a =>
      (a.code || '').toLowerCase().includes(q) ||
      (a.name || '').toLowerCase().includes(q) ||
      (a.type || '').toLowerCase().includes(q));
  }, [state.accounts, search]);

  // Which organisation these accounts belong to. With several connected, the
  // route silently falls back to the first — so naming it removes any doubt
  // about whose codes you are reading.
  const activeName = state.tenants.find(t => t.tenantId === state.activeTenantId)?.tenantName;

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
        <div className="card-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span>Chart of Accounts</span>
          {state.connected && state.tenants.length > 1 ? (
            <select
              className="form-input"
              value={state.activeTenantId || ''}
              onChange={e => setPicked(e.target.value)}
              style={{ padding: '3px 8px', fontSize: 12, fontWeight: 500, width: 'auto' }}
            >
              {state.tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
            </select>
          ) : activeName ? (
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>· {activeName}</span>
          ) : null}
        </div>
        {state.connected && state.accounts.length > 0 && (
          <input
            type="text"
            className="form-input"
            placeholder="Search by code, name, or type..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ maxWidth: 240 }}
          />
        )}
      </div>

      {state.status === 'loading' ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>

      ) : state.error ? (
        <div className="alert alert-error"><span className="alert-icon">✕</span>{state.error}</div>

      ) : !state.connected ? (
        // Says what to do, and points at the card directly above this one.
        <div className="empty-state" style={{ padding: '28px 0' }}>
          <div className="empty-state-icon">🔌</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Not connected to Xero</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 380, margin: '0 auto', lineHeight: 1.6 }}>
            Connect your organisation above to see the account codes available when coding a bill or receipt.
          </div>
        </div>

      ) : state.accounts.length === 0 ? (
        // Connected, but the organisation genuinely has no accounts. Rare, and a
        // different problem from not being connected.
        <div className="empty-state" style={{ padding: '28px 0' }}>
          <div className="empty-state-icon">📋</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No accounts in this organisation</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            Connected{activeName ? ` to ${activeName}` : ''}, but Xero returned no accounts.
          </div>
        </div>

      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: '28px 0' }}>
          <div className="empty-state-icon">🔍</div>
          <div>No accounts match “{search}”</div>
        </div>

      ) : (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
            Read live from Xero. These are the codes offered when you assign an account to a bill
            or receipt — check here if the picker is missing something you expect.
          </div>
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
            {filtered.length === state.accounts.length
              ? `${state.accounts.length} accounts`
              : `${filtered.length} of ${state.accounts.length} accounts`} · read-only, managed in Xero
          </div>
        </>
      )}
    </div>
  );
}
