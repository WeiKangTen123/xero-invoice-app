import { useEffect, useState } from 'react';
import Modal from '../../components/Modal';
import { api } from '../../api/client';
import { fmtCell, fmtMoney } from '../../utils/format';
import {
  bankOptionsBody, bankOptionsForm, bankStart, basisLabel, contactOf, emptyEntryForm, entriesFrom, entryBody,
  entryFor, entryForm, itemTitle, longDay, overrideFromForm, repeatOptions, validateEntry, weekdayDay,
} from './cash-manager';

// The Cash Flow Manager's three dialogs: bank options, an entry of one's own
// (added, or edited), and a change to an item Xero holds. Each validates as
// the server does before sending (cash-manager.js), sends one request, and
// hands back to the tab, which reloads the forecast and says what changed.
// Nothing here writes to Xero.
//
// `onSaved(message)` reloads and toasts; it is awaited, so the dialog stays
// up, busy, until the forecast under it shows the change.

function Field({ label, htmlFor, error, hint, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label className="form-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>{error}</div>
        : hint ? <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

function ErrorLine({ text }) {
  if (!text) return null;
  return <div className="alert alert-error" style={{ marginTop: 10, marginBottom: 0 }}><span className="alert-icon">✕</span>{text}</div>;
}

function Title({ children, sub }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 16 }}>{children}</div>
      {sub && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>{sub}</div>}
    </div>
  );
}

// The query a request that has no body carries the organisation in.
const tenantQuery = tenantId => (tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '');

// ── Bank options ────────────────────────────────────────────────────────────

// Which bank accounts the forecast starts from, and for each an adjustment
// to its Xero balance (money in transit, a cheque not yet banked) and the
// overdraft limit that colours the balance line. An account in another
// currency is shown, so its absence is not a mystery, but cannot be counted:
// the forecast is in the base currency.
export function BankOptionsModal({ bank, tenantId, currency, onClose, onSaved }) {
  const accounts = bank?.accounts || [];
  const [form, setForm] = useState(() => bankOptionsForm(accounts));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { body, errors } = bankOptionsBody(accounts, form, tenantId);
  const invalid = Object.keys(errors).length > 0;

  function change(id, patch) {
    setForm(f => ({ ...f, [id]: { ...f[id], ...patch } }));
  }

  async function save(e) {
    e.preventDefault();
    if (invalid) return;
    setSaving(true);
    setError('');
    try {
      await api.put('/cash-manager/bank-options', body);
      await onSaved('Bank options saved. Xero is unchanged.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save the bank options');
      setSaving(false);
    }
  }

  const input = { fontSize: 13, padding: '7px 10px' };
  return (
    <Modal onClose={onClose} busy={saving} maxWidth={620} label="Bank options">
      <form onSubmit={save}>
        <Title sub="Choose the accounts the forecast starts from. An opening adjustment adds to an account's Xero balance, or takes from it with a minus; the overdraft limit is how far below zero the balance line stays orange before it turns red.">
          Bank options
        </Title>
        {accounts.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Xero returned no bank accounts.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {accounts.map(a => {
            const f = form[a.accountId];
            const err = errors[a.accountId] || {};
            const id = `bank-${a.accountId}`;
            return (
              <div key={a.accountId} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px',
                                               background: a.foreign ? 'var(--bg-secondary)' : 'var(--bg-card)', opacity: a.foreign ? 0.7 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                    <input type="checkbox" checked={!a.foreign && !!f?.included} disabled={a.foreign || saving}
                           onChange={e => change(a.accountId, { included: e.target.checked })} />
                    {a.name}
                  </label>
                  <span style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                    {fmtMoney(a.balance, a.currency)}
                  </span>
                </div>
                {a.foreign ? (
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>Not counted (foreign currency)</div>
                ) : (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                    <div style={{ flex: '1 1 160px' }}>
                      <Field label="Opening adjustment" htmlFor={`${id}-adj`} error={err.openingAdjustment}>
                        <input id={`${id}-adj`} className="form-input" style={input} inputMode="decimal" placeholder="0.00"
                               value={f?.openingAdjustment ?? ''} disabled={saving || !f?.included}
                               onChange={e => change(a.accountId, { openingAdjustment: e.target.value })} />
                      </Field>
                    </div>
                    <div style={{ flex: '1 1 160px' }}>
                      <Field label="Overdraft limit" htmlFor={`${id}-od`} error={err.overdraft}>
                        <input id={`${id}-od`} className="form-input" style={input} inputMode="decimal" placeholder="0.00"
                               value={f?.overdraft ?? ''} disabled={saving || !f?.included}
                               onChange={e => change(a.accountId, { overdraft: e.target.value })} />
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {accounts.length > 0 && (
          <div style={{ fontSize: 12.5, marginTop: 12, color: 'var(--text-secondary)' }}>
            The forecast starts from <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(bankStart(accounts, form), currency)}</strong>.
          </div>
        )}
        <ErrorLine text={error} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving || invalid || accounts.length === 0}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── An entry of one's own ───────────────────────────────────────────────────

// Cash in or out that Xero does not hold: a loan drawdown, a tax payment,
// a grant. Added once or on a repeat. With `entryId` the entry is edited —
// read first from the server, since a row in the list is one date of it and
// does not carry how it repeats; a repeating entry is edited as a series.
export function EntryModal({ entryId, direction = 'in', today, tenantId, currency, onClose, onSaved }) {
  const editing = !!entryId;
  const [form, setForm] = useState(() => (editing ? null : emptyEntryForm(today, direction)));
  const [loadError, setLoadError] = useState('');
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!editing) return undefined;
    let alive = true;
    api.get(`/cash-manager/entries${tenantQuery(tenantId)}`)
      .then(r => {
        if (!alive) return;
        const entry = entryFor(entriesFrom(r), entryId);
        if (entry) setForm(entryForm(entry));
        else setLoadError('This entry is no longer in the app. Refresh to see the latest.');
      })
      .catch(err => { if (alive) setLoadError(err.message || 'Could not load the entry'); });
    return () => { alive = false; };
  }, [editing, entryId, tenantId]);

  const errors = form ? validateEntry(form) : {};
  const show = key => (tried || (form && String(form[key] ?? '') !== '') ? errors[key] : '');
  const repeating = form && form.frequency !== 'once';

  function change(patch) {
    setForm(f => ({ ...f, ...patch }));
  }

  async function save(e) {
    e.preventDefault();
    setTried(true);
    if (!form || Object.keys(errors).length) return;
    setSaving(true);
    setError('');
    try {
      const body = entryBody(form, tenantId);
      if (editing) await api.patch(`/cash-manager/entries/${encodeURIComponent(entryId)}`, body);
      else await api.post('/cash-manager/entries', body);
      await onSaved(editing ? 'Entry saved. Xero is unchanged.' : 'Entry added. Xero is unchanged.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save the entry');
      setSaving(false);
    }
  }

  const side = (key, label) => (
    <button type="button" aria-pressed={form?.direction === key} onClick={() => change({ direction: key })} disabled={saving}
            style={{
              flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
              border: `1.5px solid ${form?.direction === key ? (key === 'in' ? 'var(--success)' : 'var(--danger)') : 'var(--border)'}`,
              background: form?.direction === key ? (key === 'in' ? 'var(--success-subtle)' : 'var(--danger-subtle)') : 'transparent',
              color: form?.direction === key ? (key === 'in' ? 'var(--success)' : 'var(--danger)') : 'var(--text-muted)',
            }}>
      {label}
    </button>
  );

  return (
    <Modal onClose={onClose} busy={saving} maxWidth={480} label={editing ? 'Edit entry' : 'Add cash in or out'}>
      <form onSubmit={save} noValidate>
        <Title sub="Kept in this app to plan with. Nothing is created in Xero.">
          {editing ? (repeating ? 'Edit repeating entry' : 'Edit entry') : 'Add cash in or out'}
        </Title>
        {editing && !form && !loadError && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading the entry…</div>}
        <ErrorLine text={loadError} />
        {form && (
          <>
            {editing && repeating && (
              <div className="alert alert-info" style={{ fontSize: 12.5, marginBottom: 12 }}>
                <span className="alert-icon">↻</span>
                <span>A repeating entry: changes apply to every date in the series, from its first date.</span>
              </div>
            )}
            <div role="group" aria-label="Cash in or cash out" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {side('in', 'Cash in')}
              {side('out', 'Cash out')}
            </div>
            <Field label="Description" htmlFor="cm-entry-desc" error={show('description')}
                   hint={`${String(form.description || '').trim().length}/120`}>
              <input id="cm-entry-desc" className="form-input" value={form.description} maxLength={120} autoFocus disabled={saving}
                     placeholder={form.direction === 'out' ? 'e.g. GST payment' : 'e.g. Loan drawdown'}
                     onChange={e => change({ description: e.target.value })} />
            </Field>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 150px' }}>
                <Field label={`Amount${currency ? ` (${currency})` : ''}`} htmlFor="cm-entry-amount" error={show('amount')}>
                  <input id="cm-entry-amount" className="form-input" inputMode="decimal" placeholder="0.00" value={form.amount} disabled={saving}
                         onChange={e => change({ amount: e.target.value })} />
                </Field>
              </div>
              <div style={{ flex: '1 1 150px' }}>
                <Field label={repeating ? 'First date' : 'Date'} htmlFor="cm-entry-date" error={show('date')}>
                  <input id="cm-entry-date" type="date" className="form-input" value={form.date} disabled={saving}
                         onChange={e => change({ date: e.target.value })} />
                </Field>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 150px' }}>
                <Field label="Repeat" htmlFor="cm-entry-repeat" error={show('frequency')}>
                  <select id="cm-entry-repeat" className="form-input" value={form.frequency} disabled={saving}
                          onChange={e => change({ frequency: e.target.value })}>
                    {repeatOptions().map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                </Field>
              </div>
              {repeating && (
                <div style={{ flex: '1 1 150px' }}>
                  <Field label="End date (optional)" htmlFor="cm-entry-end" error={show('endDate')} hint="Blank repeats it to the end of the forecast.">
                    <input id="cm-entry-end" type="date" className="form-input" value={form.endDate} min={form.date || undefined} disabled={saving}
                           onChange={e => change({ endDate: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
          </>
        )}
        <ErrorLine text={error} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !form || (tried && Object.keys(errors).length > 0)}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── A change to an item Xero holds ──────────────────────────────────────────

// Move an invoice or bill to the date it is really expected, by picking one
// or shifting the current one some days either way, and/or change what it is
// expected to bring. Xero keeps its own dates and amounts; "Reset to Xero's"
// drops the change made here.
export function OverrideModal({ item, tenantId, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    how: 'date', date: item.date || '', shift: '',
    amount: Number.isFinite(Number(item.amount)) ? Number(item.amount).toFixed(2) : '',
  }));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { body, errors } = overrideFromForm(item, form);
  const t = itemTitle(item);
  const xeroAmount = item.originalAmount ?? item.amount;
  const shifted = form.how === 'shift' && body.date ? body.date : '';

  function change(patch) {
    setForm(f => ({ ...f, ...patch }));
  }

  async function save(e) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(errors).length) return;
    setSaving(true);
    setError('');
    try {
      await api.put('/cash-manager/overrides', { ...(tenantId ? { tenantId } : {}), ...body });
      await onSaved('Changed in this app. Xero is unchanged.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not save the change');
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setError('');
    try {
      const q = new URLSearchParams({ key: item.key });
      if (tenantId) q.set('tenantId', tenantId);
      await api.delete(`/cash-manager/overrides?${q.toString()}`);
      await onSaved('Back to Xero\'s date and amount.');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not reset the change');
      setSaving(false);
    }
  }

  const radio = (key, label) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
      <input type="radio" name="cm-how" checked={form.how === key} disabled={saving} onChange={() => change({ how: key })} /> {label}
    </label>
  );

  return (
    <Modal onClose={onClose} busy={saving} maxWidth={460} label="Change date or amount">
      <form onSubmit={save} noValidate>
        <Title sub="The change is kept in this app for the forecast. Xero is unchanged.">Change date or amount</Title>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', marginBottom: 14 }}>
          <div style={{ fontWeight: 600 }}>{contactOf(item)} · {t.primary}</div>
          <div style={{ color: 'var(--text-muted)' }}>
            In Xero: {item.dueDate ? `due ${longDay(item.dueDate)}` : 'no due date'} · {fmtCell(xeroAmount)}
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            Now expected: {longDay(item.date) || '—'}{basisLabel(item.dateBasis) ? ` (${basisLabel(item.dateBasis)})` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
          {radio('date', 'Pick a date')}
          {radio('shift', 'Shift by days')}
        </div>
        {form.how === 'date' ? (
          <Field label="Expected date" htmlFor="cm-ov-date" error={tried || form.date ? errors.date : ''}>
            <input id="cm-ov-date" type="date" className="form-input" value={form.date} disabled={saving}
                   onChange={e => change({ date: e.target.value })} />
          </Field>
        ) : (
          <Field label="Shift by (days, minus for earlier)" htmlFor="cm-ov-shift" error={errors.shift}
                 hint={shifted ? `Moves to ${weekdayDay(shifted)} ${shifted.slice(0, 4)}` : 'e.g. 14 for a fortnight later, -7 for a week earlier'}>
            <input id="cm-ov-shift" className="form-input" inputMode="numeric" value={form.shift} disabled={saving}
                   onChange={e => change({ shift: e.target.value })} />
          </Field>
        )}
        <Field label="Amount" htmlFor="cm-ov-amount" error={errors.amount}
               hint={`Xero's amount: ${fmtCell(xeroAmount)}`}>
          <input id="cm-ov-amount" className="form-input" inputMode="decimal" value={form.amount} disabled={saving}
                 onChange={e => change({ amount: e.target.value })} />
        </Field>
        {tried && errors.form && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{errors.form}.</div>}
        <ErrorLine text={error} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {item.overridden && (
            <button type="button" className="btn btn-outline btn-sm" style={{ marginRight: 'auto' }} onClick={reset} disabled={saving}
                    title="Drop the change made here and use Xero's date and amount again">
              Reset to Xero&apos;s
            </button>
          )}
          <button type="button" className="btn btn-outline btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}
