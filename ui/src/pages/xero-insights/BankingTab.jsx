import { fmtMoney } from '../../utils/format';
import { formatDateTime } from '../../utils/formatDate';
import { BarList, GroupedMonthlyBars } from '../../components/performance/PerformancePanels';
import { balanceFor } from './balances';
import { SourceNote } from './bits';

export default function BankingTab({ user, isMobile, banking, selectedBankAccount, setSelectedBankAccount, statement, perf, viewStatement, bankBalances, currency }) {
  return (
        <>
          {/* Moved from Overview: cash movement belongs with the accounts it
              moved through. Reads the cached performance payload, so it costs no
              extra Xero call. */}
          {perf.data?.cash?.available && (
            <div className="card" style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 3 }}>Cash at bank</div>
                <div style={{ fontSize: 21, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(perf.data.cash.total, currency)}</div>
              </div>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', fontSize: 12.5 }}>
                <div><span style={{ color: 'var(--text-muted)' }}>Cash in </span><b style={{ color: 'var(--success)' }}>{fmtMoney(perf.data.cash.cashIn, currency)}</b></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Cash out </span><b style={{ color: 'var(--danger)' }}>{fmtMoney(perf.data.cash.cashOut, currency)}</b></div>
                <div><span style={{ color: 'var(--text-muted)' }}>Net </span><b style={{ color: perf.data.cash.net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtMoney(perf.data.cash.net, currency)}</b></div>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                {perf.data.fiscalYear?.label} · Xero Bank Summary
              </div>
            </div>
          )}

          {/* Both charts read perf.data.cash.accounts, which this tab already
              receives — no extra Xero call. Until now that array was fetched
              and discarded, so the balance of each account was never shown. */}
          {perf.data?.cash?.accounts?.length > 0 && (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 }}>
              <div className="card" style={{ flex: 6, minWidth: 320 }}>
                <div className="card-title">Where the money sits</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Closing balance per account, and its share of total cash.
                </div>
                <BarList
                  currency={currency}
                  showPctOfTotal
                  items={perf.data.cash.accounts
                    .filter(a => a.balance !== 0)
                    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
                    .map(a => ({ label: a.name, value: a.balance }))}
                />
              </div>

              <div className="card" style={{ flex: 6, minWidth: 320 }}>
                <div className="card-title">Movement by account</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
                  Which account is actually doing the work this period.
                </div>
                <GroupedMonthlyBars
                  rawLabels
                  currency={currency}
                  months={perf.data.cash.accounts.map(a => ({ key: a.name, label: a.name }))}
                  series={[
                    { label: 'In',  color: 'var(--success)', values: perf.data.cash.accounts.map(a => a.cashIn  || 0) },
                    { label: 'Out', color: 'var(--danger)',  values: perf.data.cash.accounts.map(a => a.cashOut || 0) },
                  ]}
                />
                <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 10.5, color: 'var(--text-muted)' }}>
                  <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--success)', marginRight: 5 }} />In</span>
                  <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--danger)', marginRight: 5 }} />Out</span>
                </div>
              </div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ marginBottom: 2 }}>Bank &amp; Cash Accounts</div>
            <div className="card-subtitle" style={{ marginBottom: 2 }}>Click an account for its transaction statement.</div>
            <SourceNote>Xero Accounts API (Type=BANK)</SourceNote>
            {banking.status !== 'done' ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
            ) : banking.error ? (
              <div className="alert alert-error"><span className="alert-icon">✕</span>{banking.error}</div>
            ) : banking.data.length === 0 ? (
              <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">🏦</div><div>No bank accounts found in Xero</div></div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                    <th style={{ padding: '6px 10px' }}>Name</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Balance</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>In</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right' }}>Out</th>
                    <th style={{ padding: '6px 10px' }}>Account Number</th><th style={{ padding: '6px 10px' }}>Currency</th>
                    <th style={{ padding: '6px 10px' }}>Status</th><th style={{ padding: '6px 10px' }}></th>
                  </tr></thead>
                  <tbody>{banking.data.map(a => {
                    const bal = balanceFor(bankBalances, a);
                    return (
                    <tr key={a.accountId} style={{ borderTop: '1px solid var(--border)', background: selectedBankAccount?.accountId === a.accountId ? 'var(--bg-hover)' : undefined }}>
                      <td style={{ padding: '9px 10px' }}>
                        {a.name}
                        {a.code ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> · {a.code}</span> : null}
                      </td>
                      {/* Em dash when the name join misses, never a wrong number. */}
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                        {bal ? fmtMoney(bal.balance, a.currency || currency) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: bal?.cashIn ? 'var(--success)' : 'var(--text-muted)' }}>
                        {bal?.cashIn ? fmtMoney(bal.cashIn, a.currency || currency) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: bal?.cashOut ? 'var(--danger)' : 'var(--text-muted)' }}>
                        {bal?.cashOut ? fmtMoney(bal.cashOut, a.currency || currency) : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{a.accountNumber || '—'}</td>
                      <td style={{ padding: '9px 10px' }}>{a.currency || '—'}</td>
                      <td style={{ padding: '9px 10px' }}><span className={`badge ${a.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{a.status || '—'}</span></td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => viewStatement(a)}>View Transactions</button>
                      </td>
                    </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </div>

          {selectedBankAccount && (
            <div className="card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <div className="card-title" style={{ marginBottom: 0 }}>Statement — {selectedBankAccount.name}</div>
                <button type="button" className="btn btn-sm" style={{ background: 'none', color: 'var(--text-muted)', border: 'none' }} onClick={() => setSelectedBankAccount(null)}>✕ Close</button>
              </div>
              <div className="card-subtitle" style={{ marginBottom: 2 }}>Most recent transactions for this account</div>
              <SourceNote>Xero Bank Transactions + Payments API — bill/invoice payments show up here too, not just raw bank entries</SourceNote>
              {/* Unreconciled items are the clearest sign the books and the bank
                  disagree. The flag was already on every row, but as a faint dash
                  with no total — easy to scroll past. */}
              {statement.status === 'done' && !statement.error && statement.data.length > 0 && (() => {
                const un = statement.data.filter(t => !t.isReconciled).length;
                return un === 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--success)', marginBottom: 10 }}>
                    ✓ All {statement.data.length} transactions shown are reconciled.
                  </div>
                ) : (
                  <div style={{ fontSize: 11.5, color: 'var(--warning)', marginBottom: 10, lineHeight: 1.5 }}>
                    ▲ {un} of {statement.data.length} transactions shown are not reconciled — the books and the
                    bank statement disagree until they are matched in Xero.
                  </div>
                );
              })()}
              {statement.status !== 'done' ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
              ) : statement.error ? (
                <div className="alert alert-error"><span className="alert-icon">✕</span>{statement.error}</div>
              ) : statement.data.length === 0 ? (
                <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">📄</div><div>No transactions found for this account</div></div>
              ) : (
                <div style={{
                  overflowX: 'auto',
                  // A 480px scroll region inside a page that already scrolls
                  // takes ~75% of a phone viewport and captures the thumb, so
                  // getting past the table means finding the margin beside it.
                  // On a phone the list just runs and the page scrolls as one.
                  maxHeight: isMobile ? 'none' : 480,
                  overflowY: isMobile ? 'visible' : 'auto',
                }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 11 }}>
                      <th style={{ padding: '6px 10px' }}>Date</th><th style={{ padding: '6px 10px' }}>Type</th>
                      <th style={{ padding: '6px 10px' }}>Contact</th><th style={{ padding: '6px 10px' }}>Reference</th>
                      <th style={{ padding: '6px 10px' }}>Source</th>
                      <th style={{ padding: '6px 10px' }}>Reconciled</th><th style={{ padding: '6px 10px', textAlign: 'right' }}>Amount</th>
                    </tr></thead>
                    <tbody>{statement.data.map(t => (
                      <tr key={t.transactionId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{formatDateTime(t.date, user?.timezone).split(',')[0]}</td>
                        <td style={{ padding: '9px 10px' }}><span className={`badge ${t.type === 'Money In' ? 'badge-green' : 'badge-red'}`}>{t.type}</span></td>
                        <td style={{ padding: '9px 10px' }}>{t.contact}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{t.reference || '—'}</td>
                        <td style={{ padding: '9px 10px', color: 'var(--text-muted)', fontSize: 11 }}>{t.source === 'payment' ? 'Invoice payment' : 'Bank'}</td>
                        <td style={{ padding: '9px 10px' }}>
                          {t.isReconciled
                            ? <span style={{ color: 'var(--success)' }}>✓</span>
                            : <span className="badge badge-yellow" style={{ fontSize: 11 }}>not matched</span>}
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: t.type === 'Money In' ? 'var(--success)' : 'var(--danger)' }}>
                          {t.type === 'Money In' ? '+' : '−'}{fmtMoney(t.total, currency)}
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
  );
}
