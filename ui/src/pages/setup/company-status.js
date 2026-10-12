// The connected-companies list on Setup's Xero card: what each row's badge
// says, and what stands in for the list when there are no rows to show.
//
// Every company used to show "● Live" whatever the connection's state, so a
// connection Xero had stopped accepting still looked live here while nothing
// could be sent. A row is Live only when /api/xero/connection says connected
// and asks for no reconnect.
//
// Imports nothing, so main/scripts/setup-companies-ui.test.js can run it as it
// is; Setup.jsx only lays it out.

// What stands where the rows are: 'loading', 'failed' (the companies could
// not be read, so it is not known whether any are connected), 'none' or
// 'list'.
export function companiesView(tenants, tenantsFailed) {
  if (tenantsFailed) return 'failed';
  if (tenants === null || tenants === undefined) return 'loading';
  return tenants.length ? 'list' : 'none';
}

// The badge on each company row, from the last answer of /xero/connection
// (null when there is none) and whether the last check failed.
// { text, className, title }
export function companyBadge(connection, connectionFailed) {
  if (connection) {
    if (connection.connected && !connection.needsReconnect) {
      return { text: '● Live', className: 'badge badge-green', title: 'Connected: documents can be sent to this company' };
    }
    return {
      text: 'Needs reconnect', className: 'badge badge-yellow',
      title: connection.reason || 'Xero is not accepting this connection. Connect again to send to this company.',
    };
  }
  if (connectionFailed) {
    return { text: 'Couldn’t check', className: 'badge badge-gray', title: 'The connection could not be checked just now' };
  }
  return { text: 'Checking…', className: 'badge badge-gray', title: 'Checking the connection' };
}
