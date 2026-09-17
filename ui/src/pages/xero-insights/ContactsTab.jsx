import { SearchBox, SourceNote } from './bits';

export default function ContactsTab({ isMobile, contacts, contactSearch, setContactSearch, filteredContacts }) {
  return (
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>Contacts</div>
            <SearchBox value={contactSearch} onChange={setContactSearch} placeholder="Search by name or email..." />
          </div>
          <SourceNote>Xero Contacts API</SourceNote>
          {contacts.status !== 'done' ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>Loading…</div>
          ) : contacts.error ? (
            <div className="alert alert-error"><span className="alert-icon">✕</span>{contacts.error}</div>
          ) : filteredContacts.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px 0' }}><div className="empty-state-icon">👥</div><div>No contacts match</div></div>
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
                  <th style={{ padding: '6px 10px' }}>Name</th><th style={{ padding: '6px 10px' }}>Email</th>
                  <th style={{ padding: '6px 10px' }}>Customer</th><th style={{ padding: '6px 10px' }}>Supplier</th>
                  <th style={{ padding: '6px 10px' }}>Status</th>
                </tr></thead>
                <tbody>{filteredContacts.map(c => (
                  <tr key={c.contactId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 10px' }}>{c.name}</td>
                    <td style={{ padding: '9px 10px', color: 'var(--text-muted)' }}>{c.email || '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{c.isCustomer ? '✓' : '—'}</td>
                    <td style={{ padding: '9px 10px' }}>{c.isSupplier ? '✓' : '—'}</td>
                    <td style={{ padding: '9px 10px' }}><span className={`badge ${c.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{c.status || '—'}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
  );
}
