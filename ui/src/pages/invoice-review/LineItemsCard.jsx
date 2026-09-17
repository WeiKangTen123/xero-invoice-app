import { fmtMoney } from '../../utils/format';

export default function LineItemsCard({ id, inv, editing, form, updateField, updateLineItem }) {
  return (
              <div className="card">
                {(editing ? form.lineItems : inv.lineItems)?.length > 0 && (
                  <>
                    <div className="card-title" style={{ marginBottom: 12 }}>
                      Line Items ({(editing ? form.lineItems : inv.lineItems).length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {(editing ? form.lineItems : inv.lineItems).map((li, i) => (
                        editing ? (
                          <div key={i} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <input className="form-input" value={li.description || ''} placeholder="Description"
                              onChange={e => updateLineItem(i, 'description', e.target.value)} />
                            <input className="form-input" type="number" step="0.01" value={li.unitAmount ?? ''} placeholder="Amount"
                              onChange={e => updateLineItem(i, 'unitAmount', e.target.value)} />
                          </div>
                        ) : (
                          <div key={i} style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                            <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 4, lineHeight: 1.4 }}>{li.description}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                              <span>{fmtMoney(li.unitAmount, inv.currency)}</span>
                              {li.discountRate > 0 && <span>· {li.discountRate}% disc.</span>}
                              {li.taxType && li.taxType !== 'NONE' && <span className="badge badge-yellow">{li.taxType}</span>}
                            </div>
                          </div>
                        )
                      ))}
                    </div>

                    {editing ? (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                          <label htmlFor="rv-li-subtotal" className="form-label">Subtotal</label>
                          <input id="rv-li-subtotal" className="form-input" type="number" step="0.01" value={form.subTotal}
                            onChange={e => updateField('subTotal', e.target.value)} />
                        </div>
                        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                          <label htmlFor="rv-li-tax" className="form-label">Tax</label>
                          <input id="rv-li-tax" className="form-input" type="number" step="0.01" value={form.taxAmount}
                            onChange={e => updateField('taxAmount', e.target.value)} />
                        </div>
                      </div>
                    ) : inv.subTotal > 0 && inv.taxAmount > 0 && (
                      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                          <span>Subtotal</span><span>{fmtMoney(inv.subTotal, inv.currency)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted)' }}>
                          <span>Tax</span><span>{fmtMoney(inv.taxAmount, inv.currency)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                          <span>Total</span><span>{fmtMoney(inv.totalAmount, inv.currency)}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {(inv.paymentReference || editing) && (
                  <div style={{ marginTop: (editing ? form.lineItems : inv.lineItems)?.length > 0 ? 14 : 0, paddingTop: (editing ? form.lineItems : inv.lineItems)?.length > 0 ? 14 : 0, borderTop: (editing ? form.lineItems : inv.lineItems)?.length > 0 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>
                      Payment Reference
                    </div>
                    {editing ? (
                      <input className="form-input" value={form.paymentReference}
                        onChange={e => updateField('paymentReference', e.target.value)} />
                    ) : (
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{inv.paymentReference}</div>
                    )}
                  </div>
                )}
              </div>
  );
}
