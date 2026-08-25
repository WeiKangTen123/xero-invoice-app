import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../api/client';

// Searchable account picker backed by the connected Xero org's chart of accounts.
//
// A plain <select> won't do: account codes are defined inside Xero, so a different
// org has a different chart, and someone may legitimately need a code this org
// doesn't have yet. So this is a combobox — pick from Xero, or type any code and
// keep it. The stored value is always the bare code ("200"), unchanged from the
// free-text input this replaces, so nothing downstream has to know about it.
//
// Rides on /api/xero-reports/accounts, which already exists on the
// accounting.settings.read scope — no new Xero permission needed.

// Xero's account types, in the order a chart of accounts is normally read.
// Anything unrecognised sorts last under its own raw type name.
const TYPE_ORDER = ['REVENUE', 'SALES', 'OTHERINCOME', 'DIRECTCOSTS', 'EXPENSE', 'OVERHEADS',
                    'WAGESEXPENSE', 'SUPERANNUATIONEXPENSE', 'DEPRECIATN',
                    'CURRENT', 'INVENTORY', 'PREPAYMENT', 'FIXED', 'NONCURRENT',
                    'CURRLIAB', 'LIABILITY', 'PAYGLIABILITY', 'SUPERANNUATIONLIABILITY',
                    'TERMLIAB', 'EQUITY'];
// Confirmed against a live 57-account chart, which included INVENTORY — an
// unlabelled type would otherwise surface a raw enum as a group heading.
const TYPE_LABEL = {
  REVENUE: 'Revenue', SALES: 'Sales', OTHERINCOME: 'Other income',
  DIRECTCOSTS: 'Direct costs', EXPENSE: 'Expense', OVERHEADS: 'Overheads',
  WAGESEXPENSE: 'Wages expense', SUPERANNUATIONEXPENSE: 'Superannuation expense',
  DEPRECIATN: 'Depreciation', CURRENT: 'Current asset', INVENTORY: 'Inventory',
  PREPAYMENT: 'Prepayment', FIXED: 'Fixed asset', NONCURRENT: 'Non-current asset',
  CURRLIAB: 'Current liability', LIABILITY: 'Liability',
  PAYGLIABILITY: 'PAYG liability', SUPERANNUATIONLIABILITY: 'Superannuation liability',
  TERMLIAB: 'Term liability', EQUITY: 'Equity',
};

// A bill is coded to a cost account, a sales invoice to a revenue account. Both
// lists stay fully reachable — this only decides what floats to the top.
const RELEVANT_FIRST = {
  ACCPAY: ['DIRECTCOSTS', 'EXPENSE', 'OVERHEADS'],
  ACCREC: ['REVENUE', 'OTHERINCOME'],
};

function typeLabel(type) { return TYPE_LABEL[type] || (type || 'Other'); }

// Module-level cache: the chart of accounts is the same for every field on the
// page, and InvoiceReview renders this alongside a Setup default. Without it,
// mounting two of these fires two identical requests against Xero's rate limit.
// Keyed BY ORGANISATION, not global. Each Xero org has its own chart of
// accounts, so a single shared cache would hand org A's account list to org B —
// and the request itself carries no tenantId, so the server would fall back to
// whichever org happens to be first. Harmless with one org connected, wrong the
// moment there are two.
const _cache = new Map(); // tenantId|'default' -> { accounts, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cacheKey = tenantId => tenantId || 'default';

// Resolves a code to its account name for read-only display, sharing the same
// module cache as the picker so it costs no extra request. Returns null until the
// chart of accounts is available, and for a code this org doesn't have — callers
// fall back to showing the bare code.
// Shared fetch so the picker and the read-only label can never disagree about
// which org's chart they are showing.
function _fetchAccounts(tenantId) {
  const key = _cacheKey(tenantId);
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return Promise.resolve(hit.accounts);
  const qs = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  return api.get(`/xero-reports/accounts${qs}`).then(d => {
    const list = (d.accounts || []).filter(a => a.code && a.type !== 'BANK'
                                             && (!a.status || a.status === 'ACTIVE'));
    _cache.set(key, { accounts: list, fetchedAt: Date.now() });
    return list;
  });
}

export function useAccountName(code, tenantId) {
  const [accounts, setAccounts] = useState(() => _cache.get(_cacheKey(tenantId))?.accounts || null);

  useEffect(() => {
    let alive = true;
    _fetchAccounts(tenantId)
      .then(list => { if (alive) setAccounts(list); })
      .catch(() => { /* read-only display falls back to the code alone */ });
    return () => { alive = false; };
  }, [tenantId]);

  if (!code || !accounts) return null;
  return accounts.find(a => String(a.code) === String(code).trim())?.name || null;
}

export default function AccountCodeSelect({ value, onChange, invoiceType, disabled, autoFocus, tenantId }) {
  const [accounts, setAccounts] = useState(() => _cache.get(_cacheKey(tenantId))?.accounts || null);
  const [failed,   setFailed]   = useState(false);
  const [open,     setOpen]     = useState(false);
  const [query,    setQuery]    = useState('');
  const wrapRef  = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let alive = true;
    // Bank accounts can't take a line item and archived ones shouldn't be
    // offered for new coding — both filtered in _fetchAccounts.
    _fetchAccounts(tenantId)
      .then(list => { if (alive) setAccounts(list); })
      // Not connected to Xero, or a missing scope — fall back to a plain text
      // box rather than trapping the user behind an empty dropdown.
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [tenantId]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey  = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const selected = useMemo(
    () => (accounts || []).find(a => String(a.code) === String(value || '').trim()) || null,
    [accounts, value],
  );

  // Grouped by Xero's own account type, relevant types first for this invoice type.
  const groups = useMemo(() => {
    if (!accounts) return [];
    const q = query.trim().toLowerCase();
    const match = a => !q || a.name.toLowerCase().includes(q) || String(a.code).toLowerCase().includes(q);

    const byType = new Map();
    for (const a of accounts) {
      if (!match(a)) continue;
      if (!byType.has(a.type)) byType.set(a.type, []);
      byType.get(a.type).push(a);
    }

    const preferred = RELEVANT_FIRST[invoiceType] || [];
    const rank = t => {
      const p = preferred.indexOf(t);
      if (p >= 0) return p;                              // relevant types first
      const o = TYPE_ORDER.indexOf(t);
      return 100 + (o >= 0 ? o : TYPE_ORDER.length);     // then Xero's usual order
    };

    return [...byType.entries()]
      .sort((x, y) => rank(x[0]) - rank(y[0]))
      .map(([type, list]) => ({
        type,
        list: list.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true })),
      }));
  }, [accounts, query, invoiceType]);

  const typed       = query.trim();
  const isKnownCode = !!(accounts || []).find(a => String(a.code) === typed);
  const total       = groups.reduce((n, g) => n + g.list.length, 0);

  function pick(code) { onChange(String(code)); setQuery(''); setOpen(false); }

  // No Xero connection — behave exactly like the input this replaces.
  if (failed) {
    return (
      <>
        <input className="form-input" value={value || ''} disabled={disabled}
               placeholder="e.g. 200"
               onChange={e => onChange(e.target.value)} />
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 5 }}>
          Couldn&apos;t load the chart of accounts — enter the code manually.
        </div>
      </>
    );
  }

  const rowBase = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    width: '100%', padding: '7px 12px', fontSize: 13, textAlign: 'left',
    background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {/* Closed state shows the NAME, with the code as a quiet trailing chip —
          a bare "200" tells you nothing about what you're coding to. */}
      <button
        type="button" disabled={disabled} autoFocus={autoFocus}
        onClick={() => { setOpen(o => !o); setQuery(''); setTimeout(() => inputRef.current?.focus(), 0); }}
        className="form-input"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                 cursor: disabled ? 'not-allowed' : 'pointer', textAlign: 'left',
                 opacity: disabled ? 0.55 : 1 }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       color: value ? 'var(--text-primary)' : 'var(--text-muted)' }}>
          {selected ? selected.name : (value ? `Custom code` : 'Select an account…')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {value && (
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 700,
                           padding: '1px 7px', borderRadius: 5, background: 'var(--bg-secondary)',
                           color: selected ? 'var(--accent)' : 'var(--warning, #f59e0b)' }}>
              {value}
            </span>
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>▾</span>
        </span>
      </button>

      {/* A code the connected org doesn't have is legitimate — another org's
          chart, or one added in Xero after this list was cached. Flag it, never
          block it. */}
      {value && !selected && accounts && (
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 5 }}>
          Code <strong>{value}</strong> isn&apos;t in this Xero organisation&apos;s chart of accounts — it will still be sent as-is.
        </div>
      )}

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 5px)', left: 0, right: 0, zIndex: 60,
          background: 'var(--bg-primary)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          maxHeight: 320, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input
              ref={inputRef} className="form-input" value={query}
              placeholder="Search name or code…"
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  // Enter takes the single remaining match, else the typed code.
                  if (total === 1) pick(groups[0].list[0].code);
                  else if (typed) pick(typed);
                }
              }}
              style={{ fontSize: 13, padding: '7px 10px' }}
            />
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {!accounts && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--text-muted)' }}>Loading accounts…</div>}

            {accounts && groups.map(g => (
              <div key={g.type}>
                <div style={{ padding: '8px 12px 3px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                              textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  {typeLabel(g.type)}
                </div>
                {g.list.map(a => {
                  const isSel = String(a.code) === String(value);
                  return (
                    <button key={a.accountId || a.code} type="button" onClick={() => pick(a.code)}
                      style={{ ...rowBase, background: isSel ? 'var(--bg-hover)' : 'transparent', fontWeight: isSel ? 700 : 400 }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = isSel ? 'var(--bg-hover)' : 'transparent'; }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {a.code}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}

            {accounts && total === 0 && !typed && (
              <div style={{ padding: 14, fontSize: 12.5, color: 'var(--text-muted)' }}>No accounts found.</div>
            )}
          </div>

          {/* The escape hatch: any code the user types is accepted, whether or
              not this org has it. */}
          {typed && !isKnownCode && (
            <button type="button" onClick={() => pick(typed)}
              style={{ ...rowBase, borderTop: '1px solid var(--border)', color: 'var(--accent)', fontWeight: 600 }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span>＋ Use &ldquo;{typed}&rdquo; as a custom code</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
