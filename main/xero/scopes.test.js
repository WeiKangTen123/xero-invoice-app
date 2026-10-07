// Both ways of connecting an org must ask Xero for the same accounting
// scopes. The lists had drifted: budgets were added to OAuth only, so a
// Custom Connection got insufficient_scope on the whole dashboard and a
// "reconnect" prompt that could not fix it.
//
// The one deliberate difference is accounting.attachments: OAuth asks for it,
// a Custom Connection does not, because Xero refuses a client-credentials
// token request naming a scope the connection was never granted.
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../utils/users', () => ({
  getUserConfig: jest.fn(() => ({ XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'secret', XERO_OAUTH_CLIENT_ID: 'ocid', XERO_OAUTH_CLIENT_SECRET: 'osecret' })),
}));
jest.mock('../utils/oauth-state', () => ({ create: () => 'state-1' }));
const axios = require('axios');
const { SCOPES, OAUTH_SCOPES, ATTACHMENTS_SCOPE } = require('./xero-utils');
const connect = require('./connect');
const oauth   = require('./oauth');

test('one scope list, budgets included; OAuth adds offline_access and attachments', () => {
  expect(typeof SCOPES).toBe('string');
  for (const s of ['accounting.reports.budgetsummary.read', 'accounting.budgets.read', 'accounting.invoices']) {
    expect(SCOPES.split(' ')).toContain(s);
  }
  expect(ATTACHMENTS_SCOPE).toBe('accounting.attachments');
  expect(SCOPES.split(' ')).not.toContain('accounting.attachments');
  expect(OAUTH_SCOPES).toBe(`${SCOPES} accounting.attachments`);
  expect(connect.SCOPES).toBe(SCOPES);
  expect(oauth.SCOPES).toBe(`offline_access ${SCOPES} accounting.attachments`);
});

test('the OAuth consent link asks for attachments', () => {
  process.env.XERO_OAUTH_REDIRECT_URI = 'https://app.test/callback';
  const url = new URL(oauth.buildAuthorizeUrl('u1'));
  expect(url.searchParams.get('scope').split(' ')).toContain('accounting.attachments');
});

test('a Custom Connection token request is unchanged: exactly the shared list, no attachments', async () => {
  axios.post.mockResolvedValue({ data: { access_token: 'tok', expires_in: 1800 } });
  await connect.refreshClientCredentialsToken('u1');
  const body = axios.post.mock.calls[0][1];
  expect(body.get('grant_type')).toBe('client_credentials');
  expect(body.get('scope')).toBe(SCOPES);
  expect(body.get('scope')).toBe(
    'accounting.invoices accounting.contacts accounting.settings.read '
    + 'accounting.banktransactions.read accounting.reports.profitandloss.read accounting.reports.banksummary.read '
    + 'accounting.payments.read accounting.reports.budgetsummary.read accounting.budgets.read');
});
