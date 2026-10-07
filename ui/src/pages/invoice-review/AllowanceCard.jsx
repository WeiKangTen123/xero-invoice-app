import AccountCodeSelect from '../../components/AccountCodeSelect';
import AllowanceFields from '../../components/receipts/AllowanceFields';
import { ALLOWANCE_KINDS, allowanceSummary, formatQuantity, formatRate } from '../../components/receipts/allowance';
import { InfoRow } from './bits';

// Stands where the receipt would for a mileage or per diem claim: what was
// claimed, and how it comes to the amount. Editing changes what was typed;
// the server prices it again at the rate the claim was made at, so the amount
// is never typed here.
export default function AllowanceCard({ inv, editing, form, updateField }) {
  const meta = ALLOWANCE_KINDS[inv.claimKind];
  const d = inv.claimDetails || {};

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 22 }}>{meta.icon}</span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{meta.long}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            No receipt needed: priced at {formatRate(inv.claimRate)} {inv.currency} {meta.per}, the rate in Setup when it was made.
          </div>
        </div>
      </div>

      {editing ? (
        <>
          <AllowanceFields kind={inv.claimKind} form={form} onChange={updateField}
            rate={inv.claimRate} currency={inv.currency} idPrefix="rv-al" />
          <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
            <label className="form-label">Account</label>
            <AccountCodeSelect value={form.accountCode} onChange={v => updateField('accountCode', v)} invoiceType="EXPENSE" />
          </div>
        </>
      ) : (
        <>
          {inv.claimKind === 'mileage' ? (
            <>
              <InfoRow label="Date"        value={inv.invoiceDate} />
              <InfoRow label="From"        value={d.from} />
              <InfoRow label="To"          value={d.to} />
              <InfoRow label="Purpose"     value={d.purpose} />
              <InfoRow label="Distance"    value={d.distanceKm != null ? `${formatQuantity('mileage', d.distanceKm)} one way` : null} />
              <InfoRow label="Return trip" value={d.returnTrip ? 'Yes (distance doubled)' : 'No'} />
            </>
          ) : (
            <>
              <InfoRow label="Start date"  value={inv.invoiceDate} />
              <InfoRow label="End date"    value={d.endDate} />
              <InfoRow label="Days"        value={formatQuantity('per_diem', inv.claimQuantity)} />
              <InfoRow label="Destination" value={d.destination} />
              <InfoRow label="Purpose"     value={d.purpose} />
            </>
          )}
          <div style={{
            marginTop: 14, padding: '12px 14px', borderRadius: 8, background: 'var(--bg-secondary)',
            border: '1px solid var(--border)', fontSize: 15, fontWeight: 700, textAlign: 'center',
          }}>
            {allowanceSummary(inv)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
            No tax, and nothing to attach. Posted to Xero as owed to you (Setup: “Your name for expense claims”).
          </div>
        </>
      )}
    </div>
  );
}
