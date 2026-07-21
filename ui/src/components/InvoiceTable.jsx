export default function InvoiceTable({ invoices }) {
  if (!invoices?.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📭</div>
        <div style={{ fontWeight: 600, color: 'var(--text-secondary)', fontSize: 14 }}>No invoices yet</div>
        <div style={{ fontSize: 13 }}>Processed invoices will appear here once the watcher is running</div>
      </div>
    );
  }

  function typeInfo(type) {
    if (type === 'ACCPAY') return { label: 'Bill',    cls: 'badge-blue' };
    if (type === 'ACCREC') return { label: 'Invoice', cls: 'badge-purple' };
    return { label: type || '—', cls: 'badge-gray' };
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Invoice #</th>
            <th>Amount</th>
            <th>Type</th>
            <th>Source</th>
            <th>Processed</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv, i) => {
            const { label, cls } = typeInfo(inv.invoiceType);
            return (
              <tr key={inv.id} style={{ animation: `fadeUp 0.2s ease ${i * 0.03}s both` }}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                      background: 'var(--accent-subtle)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 11, fontWeight: 700, color: 'var(--accent)',
                    }}>
                      {(inv.vendorName || '?').slice(0, 2).toUpperCase()}
                    </div>
                    <span style={{ fontWeight: 500 }}>{inv.vendorName || '—'}</span>
                  </div>
                </td>
                <td>
                  <code style={{ fontSize: 12, background: 'var(--bg-secondary)', padding: '2px 7px', borderRadius: 4, color: 'var(--text-secondary)' }}>
                    {inv.invoiceNumber || '—'}
                  </code>
                </td>
                <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  {inv.totalAmount != null
                    ? `${inv.currency || ''} ${Number(inv.totalAmount).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : '—'}
                </td>
                <td><span className={`badge ${cls}`}>{label}</span></td>
                <td className="truncate" style={{ maxWidth: 140, fontSize: 12, color: 'var(--text-muted)' }} title={inv.source}>
                  {inv.source || '—'}
                </td>
                <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {inv.processedAt ? new Date(inv.processedAt).toLocaleString() : '—'}
                </td>
                <td>
                  <span className={`badge ${inv.status === 'created' ? 'badge-green' : 'badge-gray'}`}>
                    {inv.status === 'created' ? '✓ Created' : inv.status || '—'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
