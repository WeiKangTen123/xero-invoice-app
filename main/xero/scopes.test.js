// Both ways of connecting an org must ask Xero for the same accounting
// scopes. The lists had drifted: budgets were added to OAuth only, so a
// Custom Connection got insufficient_scope on the whole dashboard and a
// "reconnect" prompt that could not fix it.
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
const { SCOPES } = require('./xero-utils');
const connect = require('./connect');
const oauth   = require('./oauth');

test('one scope list, budgets included; OAuth adds only offline_access', () => {
  expect(typeof SCOPES).toBe('string');
  for (const s of ['accounting.reports.budgetsummary.read', 'accounting.budgets.read', 'accounting.invoices']) {
    expect(SCOPES.split(' ')).toContain(s);
  }
  expect(connect.SCOPES).toBe(SCOPES);
  expect(oauth.SCOPES).toBe(`offline_access ${SCOPES}`);
});
