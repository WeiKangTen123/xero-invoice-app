import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import ImportDialog, { encodeFiles } from '../intake/ImportDialog';

// Adding invoices by hand. An invoice is ours to produce, so there is no file
// to upload: it is either typed into the form here, or read from a spreadsheet
// with one row per line item. Both are stored for review and never posted on
// their own — that rule lives on the server (intake/profiles.js).

const SHEET_ACCEPT = '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';
const isSheet = f => /\.(xlsx|xls|csv)$/i.test(f.name);

const invoiceImportProps = {
  title: 'Import invoices',
  subtitle: 'A spreadsheet with one row per line item. Rows sharing an invoice number are one invoice.',
  accept: SHEET_ACCEPT,
  hint: '.xlsx or .csv — columns such as Invoice Number, Customer, Invoice Date, Due Date, Currency, Description, Amount',
  classify: f => (isSheet(f) ? 'sheet' : null),
  buildBody: async files => ({ sheets: await encodeFiles(files), label: files[0]?.name }),
  runningLabel: 'Reading invoices',
  summary: r => [
    { n: r.created?.length || 0,    label: 'stored for review',     tone: 'var(--success)' },
    { n: r.duplicates?.length || 0, label: 'already in the system', tone: 'var(--warning)' },
    { n: r.rejected?.length || 0,   label: 'rows with a problem',   tone: 'var(--danger)' },
  ],
  failures: r => r.rejected || [],
};

const blankLine = () => ({ description: '', unitAmount: '', discountRate: '', taxPercent: '' });

export default function InvoiceIntake({ onUploaded }) {
  const [composing, setComposing] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-sm" onClick={() => setComposing(true)}
                style={{ background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.3)', whiteSpace: 'nowrap' }}
                title="Type in an invoice for a customer">
          + New invoice
        </button>
        <button className="btn btn-sm" onClick={() => setImporting(true)} style={{ whiteSpace: 'nowrap' }}
                title="Import invoices from a spreadsheet, in the background">
          🗂 Import invoices
        </button>
      </div>
      {composing && <InvoiceForm onClose={() => setComposing(false)} onSaved={onUploaded} />}
      {importing && <ImportDialog {...invoiceImportProps} onClose={() => setImporting(false)} onImported={onUploaded} />}
    </div>
  );
}

export function InvoiceForm({ onClose, onSaved }) {
  const [f, setF] = useState({
    contactName: '', contactEmail: '', contactAddress: '', invoiceNumber: '',
    invoiceDate: new Date().toISOString().slice(0, 10), termsDays: 30, dueDate: '', currency: 'SGD', description: '',
    lineItems: [blankLine()],
  });
  const [errors, setErrors] = useState({});
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  const set  = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setLine = (i, k, v) => setF(p => ({ ...p, lineItems: p.lineItems.map((li, j) => (j === i ? { ...li, [k]: v } : li)) }));
  const addLine = () => setF(p => ({ ...p, lineItems: [...p.lineItems, blankLine()] }));
  const dropLine = i => setF(p => ({ ...p, lineItems: p.lineItems.length > 1 ? p.lineItems.filter((_, j) => j !== i) : p.lineItems }));

  // Same arithmetic as the server, so the total shown is the total stored.
  const totals = useMemo(() => {
    let sub = 0, tax = 0;
    for (const li of f.lineItems) {
      const amt = Number(li.unitAmount) || 0, disc = Number(li.discountRate) || 0, pct = Number(li.taxPercent) || 0;
      const net = amt * (1 - disc / 100);
      sub += net; tax += pct ? net * (pct / 100) : 0;
    }
    return { sub: Math.round(sub * 100) / 100, tax: Math.round(tax * 100) / 100, total: Math.round((sub + tax) * 100) / 100 };
  }, [f.lineItems]);

  async function save() {
    setSaving(true); setError(''); setErrors({});
    try {
      const body = {
        ...f,
        dueDate: f.dueDate || undefined,
        termsDays: f.dueDate ? undefined : f.termsDays,
        lineItems: f.lineItems.filter(li => li.description || li.unitAmount !== '').map(li => ({
          description: li.description, unitAmount: li.unitAmount === '' ? null : Number(li.unitAmount),
          discountRate: li.discountRate === '' ? 0 : Number(li.discountRate), taxPercent: li.taxPercent === '' ? null : Number(li.taxPercent),
        })),
      };
      await api.post('/invoices/compose', body);
      onSaved?.(); onClose();
    } catch (err) {
      // The server names the field for each problem; show them beside the fields.
      const list = err.errors || err.body?.errors || [];
      const byField = {}; for (const e of list) byField[e.field] = e.error;
      setErrors(byField);
      setError(err.message || 'Could not save the invoice');
    } finally { setSaving(false); }
  }

  const field = (label, k, props = {}) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--text-muted)', flex: props.flex ?? 1, minWidth: props.minWidth ?? 140 }}>
      {label}
      <input className="form-input" value={f[k] ?? ''} onChange={e => set(k, e.target.value)} type={props.type || 'text'} placeholder={props.placeholder || ''}
             style={{ borderColor: errors[k] ? 'var(--danger)' : undefined }} />
      {errors[k] && <span style={{ color: 'var(--danger)' }}>{errors[k]}</span>}
    </label>
  );
  const money = n => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'fadeIn 0.15s ease' }}
         onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="card" style={{ width: '100%', maxWidth: 720, maxHeight: '92vh', overflowY: 'auto', borderRadius: 18, boxShadow: 'var(--shadow-lg)', animation: 'scaleIn 0.2s ease' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>New invoice</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>Stored for your review. Nothing goes to Xero until you post it.</div>
          </div>
          <button onClick={onClose} disabled={saving} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1 }}>×</button>
        </div>

        {error && !Object.keys(errors).length && <div className="alert alert-error" style={{ marginBottom: 12 }}><span className="alert-icon">✕</span>{error}</div>}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {field('Customer', 'contactName', { flex: 2, minWidth: 200, placeholder: 'Who is being invoiced' })}
          {field('Email', 'contactEmail', { type: 'email' })}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {field('Address', 'contactAddress', { flex: 3, minWidth: 220 })}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          {field('Invoice number', 'invoiceNumber', { placeholder: 'Generated if blank' })}
          {field('Invoice date', 'invoiceDate', { type: 'date' })}
          {field('Due in (days)', 'termsDays', { type: 'number', minWidth: 110 })}
          {field('or due date', 'dueDate', { type: 'date' })}
          {field('Currency', 'currency', { minWidth: 90, placeholder: 'SGD' })}
        </div>

        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '6px 0 4px' }}>Line items</div>
        {errors.lineItems && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 6 }}>{errors.lineItems}</div>}
        {f.lineItems.map((li, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 3fr) 110px 80px 80px 32px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <input className="form-input" placeholder="Description" value={li.description} onChange={e => setLine(i, 'description', e.target.value)} />
            <input className="form-input" type="number" step="0.01" placeholder="Amount" value={li.unitAmount} onChange={e => setLine(i, 'unitAmount', e.target.value)}
                   style={{ borderColor: errors[`lineItems[${i}].unitAmount`] ? 'var(--danger)' : undefined }} />
            <input className="form-input" type="number" step="0.1" placeholder="Disc %" value={li.discountRate} onChange={e => setLine(i, 'discountRate', e.target.value)} />
            <input className="form-input" type="number" step="0.1" placeholder="Tax %" value={li.taxPercent} onChange={e => setLine(i, 'taxPercent', e.target.value)} />
            <button type="button" onClick={() => dropLine(i)} aria-label="Remove line" title="Remove line"
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
        ))}
        <button type="button" className="btn btn-outline btn-sm" onClick={addLine} style={{ marginBottom: 12 }}>+ Add line</button>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 18, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', marginBottom: 14 }}>
          <span style={{ color: 'var(--text-muted)' }}>Subtotal {money(totals.sub)}</span>
          <span style={{ color: 'var(--text-muted)' }}>Tax {money(totals.tax)}</span>
          <span style={{ fontWeight: 700 }}>Total {f.currency || ''} {money(totals.total)}</span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={onClose} disabled={saving} style={{ flex: 1 }}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving} style={{ flex: 2 }}>
            {saving ? <><span className="btn-spinner" /> Saving…</> : 'Save for review'}
          </button>
        </div>
      </div>
    </div>
  );
}
