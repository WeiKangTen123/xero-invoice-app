import { fmtMoney } from '../../utils/format';
import AccountCodeSelect from '../../components/AccountCodeSelect';
import { AccountMiniField, MiniField } from './bits';

export default function SummaryCard({ id, inv, editing, form, updateField, isExpense, typeLabel }) {
  return (
            <div className="card">
              {editing ? (
                <>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="form-group" style={{ width: 90 }}>
                      <label htmlFor="rv-currency" className="form-label">Currency</label>
                      <input id="rv-currency" className="form-input" value={form.currency} maxLength={3}
                        onChange={e => updateField('currency', e.target.value.toUpperCase())} />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="rv-total" className="form-label">Total Amount</label>
                      <input id="rv-total" className="form-input" type="number" step="0.01" value={form.totalAmount}
                        onChange={e => updateField('totalAmount', e.target.value)} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="rv-subtotal" className="form-label">Subtotal</label>
                      <input id="rv-subtotal" className="form-input" type="number" step="0.01" value={form.subTotal ?? ''}
                        placeholder="0.00"
                        onChange={e => updateField('subTotal', e.target.value !== '' ? Number(e.target.value) : null)} />
                    </div>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="rv-tax" className="form-label">Tax / GST</label>
                      <input id="rv-tax" className="form-input" type="number" step="0.01" value={form.taxAmount ?? ''}
                        placeholder="0.00"
                        onChange={e => updateField('taxAmount', e.target.value !== '' ? Number(e.target.value) : null)} />
                    </div>
                  </div>
                  <div className="form-group">
                    <label htmlFor="rv-type" className="form-label">Type</label>
                    <select id="rv-type" className="form-input" value={form.invoiceType}
                      onChange={e => updateField('invoiceType', e.target.value)}>
                      <option value="EXPENSE">Expense Claim</option>
                      <option value="ACCPAY">Bill (ACCPAY)</option>
                      <option value="ACCREC">Invoice (ACCREC)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="rv-number" className="form-label">{isExpense ? 'Claim ref' : 'Invoice #'}</label>
                    <input id="rv-number" className="form-input" value={form.invoiceNumber}
                      onChange={e => updateField('invoiceNumber', e.target.value)} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="rv-date" className="form-label">{isExpense ? 'Receipt date' : 'Invoice Date'}</label>
                      <input id="rv-date" className="form-input" type="date" value={form.invoiceDate || ''}
                        onChange={e => updateField('invoiceDate', e.target.value)} />
                    </div>
                    {!isExpense && <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="rv-due" className="form-label">Due Date</label>
                      <input id="rv-due" className="form-input" type="date" value={form.dueDate || ''}
                        onChange={e => updateField('dueDate', e.target.value)} />
                    </div>}
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Account</label>
                    {/* invoiceType floats the relevant account types to the top —
                        cost accounts for a bill, revenue accounts for a sale. */}
                    <AccountCodeSelect
                      value={form.accountCode}
                      onChange={v => updateField('accountCode', v)}
                      invoiceType={form.invoiceType}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>
                        {fmtMoney(inv.totalAmount, inv.currency)}
                      </div>
                      {(inv.subTotal != null || inv.taxAmount != null) ? (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, display: 'flex', gap: 12 }}>
                          {inv.subTotal != null && <span>Subtotal: {fmtMoney(inv.subTotal, inv.currency)}</span>}
                          {inv.taxAmount != null && <span>Tax/GST: {fmtMoney(inv.taxAmount, inv.currency)}</span>}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Total amount</div>
                      )}
                    </div>
                    <span className="badge badge-gray" style={{ fontSize: 11 }}>{typeLabel}</span>
                  </div>
                  {/* Compact 2-col grid instead of one full-width row per field */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>
                    {/* A claim is a receipt: it has a reference and a receipt date, and no due date. */}
                    <MiniField label={isExpense ? 'Claim ref' : 'Invoice #'} value={inv.invoiceNumber} mono />
                    <AccountMiniField code={inv.accountCode} />
                    <MiniField label={isExpense ? 'Receipt date' : 'Invoice Date'} value={inv.invoiceDate} />
                    {!isExpense && <MiniField label="Due Date" value={inv.dueDate} />}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                    Source: {
                      inv.source === 'claim' ? 'Expense Claim (Imported)' :
                      inv.source === 'phone' ? 'Mobile Camera Upload' :
                      inv.source === 'upload' ? 'Direct Receipt Upload' :
                      inv.source === 'pdf' ? 'PDF Attachment' :
                      (inv.receiptFile ? 'Receipt Upload' : 'Email Body')
                    }
                  </div>
                </>
              )}
            </div>
  );
}
