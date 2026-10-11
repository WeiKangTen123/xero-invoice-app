// The optional permissions on a Web app connection: live updates (journals)
// and the Balance Sheet (balance sheet and trial balance). Xero refuses some
// apps some of these at its own authorize page ("Error: invalid_scope, Error
// code: 500") and never sends the browser back, so a Connect that asked for
// one of them looked broken. These pin the pieces that keep Connect working:
// reading Xero's answer, asking only for what is allowed, and recording a
// group the person left out. Nothing here reaches Xero: axios is replaced.
jest.mock('axios');
jest.mock('../utils/oauth-state', () => ({
  create:  jest.fn((_, data) => `state:${JSON.stringify(data)}`),
  consume: jest.fn(),
}));
jest.mock('../utils/users', () => ({ getUserConfig: jest.fn(), saveUserConfig: jest.fn() }));

const mockHealth = { current: {} };
jest.mock('../utils/token-cache', () => ({
  forUser:            jest.fn(() => ({ cacheToken: jest.fn(), pruneTenants: jest.fn() })),
  getHealth:          jest.fn(() => ({ ...mockHealth.current })),
  markRefreshed:      jest.fn(),
  markScopesRefused:  jest.fn(),
  markScopesAllowed:  jest.fn(),
  markScopesDeclined: jest.fn(),
  saveScopeProbe:     jest.fn((_, probe) => { mockHealth.current = { ...mockHealth.current, scopeProbe: probe }; }),
}));

const axios = require('axios');
const { getUserConfig } = require('../utils/users');
const tokenCache = require('../utils/token-cache');
const oauth = require('./oauth');

const JOURNALS = 'accounting.journals.read';
const BS = 'accounting.reports.balancesheet.read';
const TB = 'accounting.reports.trialbalance.read';
const LOGIN = 'https://login.xero.com/identity/user/login?ReturnUrl=%2Fidentity%2Fconnect%2Fauthorize%2Fcallback%3Fx';
const ERROR = 'https://login.xero.com/identity/error?errorId=CfDJ8';

// Xero's authorize page as seen on 2026-10-11 for the owner's app: it accepts
// everything but the journals scope.
function xeroRefusing(refused) {
  axios.get.mockImplementation((url, opts) => {
    const scope = String(opts?.params?.scope || '');
    return Promise.resolve({ status: 302, headers: { location: refused.some(s => scope.includes(s)) ? ERROR : LOGIN }, data: '' });
  });
}
const scopesOf = url => new URL(url).searchParams.get('scope').split(' ');

beforeEach(() => {
  jest.clearAllMocks();
  mockHealth.current = {};
  process.env.XERO_OAUTH_REDIRECT_URI = 'https://app.test/api/xero/oauth/callback';
  getUserConfig.mockReturnValue({ XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret' });
});

describe("reading Xero's authorize page", () => {
  test.each([
    [302, LOGIN, '', 'available'],
    [302, ERROR, '', 'refused'],
    [302, 'https://app.test/api/xero/oauth/callback?error=invalid_scope&state=x', '', 'refused'],
    [302, 'https://somewhere.else/', '', 'unknown'],
    [200, '', '<html>Error: invalid_scope</html>', 'refused'],
    [200, '', '<html>Please complete the security check</html>', 'unknown'],
    [503, '', 'Service unavailable', 'unknown'],
  ])('%i to %s reads as %s', (status, location, body, expected) => {
    expect(oauth.classifyAuthorizeAnswer(status, location, body)).toBe(expected);
  });
});

describe('the probe', () => {
  test('asks the base set, then each group with it, and records what Xero refused and allowed', async () => {
    xeroRefusing([JOURNALS]);
    const probe = await oauth.probeOptionalScopes('u1');
    expect(probe).toMatchObject({ base: 'available', groups: { live: 'refused', balance: 'available' } });
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(tokenCache.markScopesRefused).toHaveBeenCalledWith('u1', [JOURNALS], { reason: 'refused at the authorize page' });
    expect(tokenCache.markScopesAllowed).toHaveBeenCalledWith('u1', [BS, TB]);
  });

  test('when Xero refuses the base set, nothing is concluded about the groups', async () => {
    axios.get.mockResolvedValue({ status: 302, headers: { location: ERROR }, data: '' });
    const probe = await oauth.probeOptionalScopes('u1');
    expect(probe).toMatchObject({ base: 'refused', groups: { live: 'unknown', balance: 'unknown' } });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(tokenCache.markScopesRefused).not.toHaveBeenCalled();
  });

  test('is reused for a day for the same Client ID, asked again when forced or when the Client ID changes', async () => {
    xeroRefusing([JOURNALS]);
    await oauth.probeOptionalScopes('u1');
    await oauth.probeOptionalScopes('u1');
    expect(axios.get).toHaveBeenCalledTimes(3);
    await oauth.probeOptionalScopes('u1', { force: true });
    expect(axios.get).toHaveBeenCalledTimes(6);
    getUserConfig.mockReturnValue({ XERO_OAUTH_CLIENT_ID: 'another', XERO_OAUTH_CLIENT_SECRET: 'secret' });
    await oauth.probeOptionalScopes('u1');
    expect(axios.get).toHaveBeenCalledTimes(9);
  });

  test('two callers at once share one probe', async () => {
    xeroRefusing([]);
    await Promise.all([oauth.probeOptionalScopes('u1'), oauth.probeOptionalScopes('u1')]);
    expect(axios.get).toHaveBeenCalledTimes(3);
  });
});

describe('what Connect asks for', () => {
  test('with no choice made, every group Xero allows and none it refuses', async () => {
    xeroRefusing([JOURNALS]);
    const r = await oauth.authorizeFor('u1');
    expect(r.requested).toEqual(['balance']);
    expect(r.excluded).toEqual({});
    expect(scopesOf(r.url)).toEqual(expect.arrayContaining([BS, TB, 'accounting.attachments', 'offline_access']));
    expect(scopesOf(r.url)).not.toContain(JOURNALS);
  });

  test('a ticked group Xero refuses is left out and reported, the rest asked for', async () => {
    xeroRefusing([JOURNALS]);
    const r = await oauth.authorizeFor('u1', { extras: ['live', 'balance'] });
    expect(r.requested).toEqual(['balance']);
    expect(r.excluded).toEqual({ live: 'refused' });
    expect(scopesOf(r.url)).not.toContain(JOURNALS);
  });

  test('nothing ticked asks for the base set alone', async () => {
    xeroRefusing([]);
    const r = await oauth.authorizeFor('u1', { extras: [] });
    expect(r.requested).toEqual([]);
    expect(scopesOf(r.url)).toEqual(oauth.BASE_SCOPES.split(' '));
  });

  test('when Xero cannot be asked, only what was ticked is tried, and nothing by default', async () => {
    axios.get.mockRejectedValue(new Error('timeout'));
    expect((await oauth.authorizeFor('u1')).requested).toEqual([]);
    expect((await oauth.authorizeFor('u1', { extras: ['live'], force: true })).requested).toEqual(['live']);
  });

  test('the state carries the groups asked for, so the callback knows', async () => {
    xeroRefusing([JOURNALS]);
    const r = await oauth.authorizeFor('u1');
    expect(new URL(r.url).searchParams.get('state')).toBe('state:{"groups":["balance"]}');
  });
});

describe('a refusal at the callback, and a completed connect', () => {
  test('a refusal naming no scope drops what that link asked for; naming one drops its whole group', () => {
    expect(oauth.scopeRefusal({ error: 'invalid_scope' }, [JOURNALS, BS, TB])).toEqual([JOURNALS, BS, TB]);
    expect(oauth.scopeRefusal({ error: 'invalid_scope', error_description: `${TB} is not allowed` }, [JOURNALS, BS, TB])).toEqual([BS, TB]);
    expect(oauth.scopeRefusal({ error: 'invalid_scope' }, [])).toBeNull();
    expect(oauth.scopeRefusal({ error: 'invalid_scope', error_description: `${JOURNALS} is not allowed` })).toEqual([JOURNALS]);
  });

  test('the retry asks for the same groups less the refused one', () => {
    const url = oauth.retryAuthorizeUrl('u1', [JOURNALS], ['live', 'balance']);
    expect(new URL(url).searchParams.get('state')).toBe('state:{"groups":["balance"]}');
  });

  test('a group the link did not ask for, and the token does not carry, is recorded as declined', async () => {
    const granted = [...oauth.BASE_SCOPES.split(' '), BS, TB];
    axios.post.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800, scope: granted.join(' ') } });
    axios.get.mockResolvedValue({ data: [{ tenantId: 't1', tenantName: 'Org' }] });
    await oauth.completeConnection('u1', 'code', { groups: ['balance'] });
    expect(tokenCache.markScopesDeclined).toHaveBeenCalledWith('u1', [JOURNALS]);
  });

  test('a connect from an older link, with no record of groups, declines nothing', async () => {
    axios.post.mockResolvedValue({ data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800 } });
    axios.get.mockResolvedValue({ data: [{ tenantId: 't1', tenantName: 'Org' }] });
    await oauth.completeConnection('u1', 'code');
    expect(tokenCache.markScopesDeclined).not.toHaveBeenCalled();
  });
});
