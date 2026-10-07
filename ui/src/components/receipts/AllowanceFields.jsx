import { ALLOWANCE_KINDS, daySpan, formQuantity, formatQuantity, formatRate, previewAmount } from './allowance';

// The inputs for a mileage or per diem claim, shared by the dialog that adds
// one and the review page that edits one, so both ask the same questions.
// `rate` is the rate the claim is priced at: Setup's for a new claim, the
// claim's own (kept from when it was made) for an edit.
export default function AllowanceFields({ kind, form, onChange, rate, currency, disabled = false, idPrefix = 'al' }) {
  const meta = ALLOWANCE_KINDS[kind];
  const quantity = formQuantity(kind, form);
  const amount = previewAmount(quantity, rate);
  const span = kind === 'per_diem' ? daySpan(form.startDate, form.endDate) : null;
  const id = name => `${idPrefix}-${name}`;
  const input = (name, label, props = {}) => (
    <div className="form-group" style={{ flex: 1, minWidth: 0, marginBottom: 10 }}>
      <label htmlFor={id(name)} className="form-label">{label}</label>
      <input id={id(name)} className="form-input" value={form[name] ?? ''} disabled={disabled}
        onChange={e => onChange(name, e.target.value)} {...props} />
    </div>
  );

  return (
    <div>
      {kind === 'mileage' ? (
        <>
          {input('date', 'Date', { type: 'date' })}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {input('from', 'From', { placeholder: 'e.g. Office', maxLength: 80 })}
            {input('to', 'To', { placeholder: 'e.g. Client A', maxLength: 80 })}
          </div>
          {input('purpose', 'Purpose', { placeholder: 'e.g. site visit', maxLength: 120 })}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {input('distanceKm', 'Distance one way (km)', { type: 'number', inputMode: 'decimal', min: '0.1', step: '0.1', placeholder: 'e.g. 42.5' })}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 18, cursor: disabled ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={!!form.returnTrip} disabled={disabled}
                onChange={e => onChange('returnTrip', e.target.checked)} />
              Return trip (doubles it)
            </label>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {input('startDate', 'Start date', { type: 'date' })}
            {input('endDate', 'End date', { type: 'date', min: form.startDate || undefined })}
          </div>
          {input('days', 'Days (optional)', {
            type: 'number', inputMode: 'decimal', min: '0.5', step: '0.5',
            // Blank counts the dates; typed, it may be less, in half days.
            placeholder: span ? `${span}, from the dates` : 'e.g. 2.5',
          })}
          {input('destination', 'Destination', { placeholder: 'e.g. Kuala Lumpur', maxLength: 80 })}
          {input('purpose', 'Purpose', { placeholder: 'e.g. conference', maxLength: 120 })}
        </>
      )}

      <div style={{
        marginTop: 4, padding: '10px 12px', borderRadius: 8, background: 'var(--bg-secondary)',
        border: '1px solid var(--border)', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ color: 'var(--text-muted)' }}>
          {formatRate(rate)} {currency} {meta.per}
        </span>
        <strong>
          {quantity ? `${formatQuantity(kind, quantity)} × ${formatRate(rate)} = ${currency} ${amount != null ? amount.toFixed(2) : '—'}` : '—'}
        </strong>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        The amount is worked out by the server when you save, from the {meta.unit === 'km' ? 'distance' : 'days'} and this rate.
      </div>
    </div>
  );
}
