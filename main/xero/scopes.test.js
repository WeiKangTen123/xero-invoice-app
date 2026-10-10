// Both ways of connecting an org must ask Xero for the same accounting
// scopes. The lists had drifted: budgets were added to OAuth only, so a
// Custom Connection got insufficient_scope on the whole dashboard and a
// "reconnect" prompt that could not fix it.
//
// The deliberate differences are accounting.attachments,
// accounting.journals.read (live updates) and the two granular report scopes
// (the Balance Sheet tab, and the trial balance with it): OAuth asks for
// them, a Custom Connection does not, because Xero refuses a
// client-credentials token request naming a scope the connection was never
// granted.
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../utils/users', () => ({
  getUserConfig: jest.fn(() => ({ XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'secret', XERO_OAUTH_CLIENT_ID: 'ocid', XERO_OAUTH_CLIENT_SECRET: 'osecret' })),
}));
jest.mock('../utils/oauth-state', () => ({ create: () => 'state-1' }));
const axios = require('axios');
const {
  SCOPES, OAUTH_SCOPES, ATTACHMENTS_SCOPE, JOURNALS_SCOPE, BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE, OPTIONAL_REPORT_SCOPES,
} = require('./xero-utils');
const connect = require('./connect');
const oauth   = require('./oauth');

test('one scope list, budgets included; OAuth adds offline_access, attachments, journals and the report scopes', () => {
  expect(typeof SCOPES).toBe('string');
  for (const s of ['accounting.reports.budgetsummary.read', 'accounting.budgets.read', 'accounting.invoices']) {
    expect(SCOPES.split(' ')).toContain(s);
  }
  expect(ATTACHMENTS_SCOPE).toBe('accounting.attachments');
  expect(JOURNALS_SCOPE).toBe('accounting.journals.read');
  expect(BALANCE_SHEET_SCOPE).toBe('accounting.reports.balancesheet.read');
  expect(TRIAL_BALANCE_SCOPE).toBe('accounting.reports.trialbalance.read');
  expect(OPTIONAL_REPORT_SCOPES).toEqual([BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE]);
  for (const s of [ATTACHMENTS_SCOPE, JOURNALS_SCOPE, BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE]) {
    expect(SCOPES.split(' ')).not.toContain(s);
  }
  expect(OAUTH_SCOPES).toBe(`${SCOPES} accounting.attachments accounting.journals.read accounting.reports.balancesheet.read accounting.reports.trialbalance.read`);
  expect(connect.SCOPES).toBe(SCOPES);
  expect(oauth.SCOPES).toBe(`offline_access ${OAUTH_SCOPES}`);
});

test('the OAuth consent link asks for attachments, journals and the report scopes', () => {
  process.env.XERO_OAUTH_REDIRECT_URI = 'https://app.test/callback';
  const url = new URL(oauth.buildAuthorizeUrl('u1'));
  for (const s of [ATTACHMENTS_SCOPE, JOURNALS_SCOPE, BALANCE_SHEET_SCOPE, TRIAL_BALANCE_SCOPE]) {
    expect(url.searchParams.get('scope').split(' ')).toContain(s);
  }
});

test('a Custom Connection token request is unchanged: exactly the shared list, no attachments or journals', async () => {
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
