jest.mock('axios');
jest.mock('../utils/oauth-state', () => ({
  create:  jest.fn(() => 'fake-state-abc'),
  consume: jest.fn(),
}));
jest.mock('../utils/users', () => ({
  getUserConfig:  jest.fn(),
  saveUserConfig: jest.fn(),
}));
jest.mock('../utils/token-cache', () => ({
  forUser: jest.fn(() => ({ cacheToken: jest.fn() })),
}));

const axios = require('axios');
const { getUserConfig, saveUserConfig } = require('../utils/users');
const tokenCache = require('../utils/token-cache');
const oauth = require('./oauth');

// Client ID/Secret are per-user (each user brings their own Xero Web app); only the
// redirect URI is global — a property of this server's deployment, not of any user.
const REDIRECT_URI = 'https://example.sslip.io/api/xero/oauth/callback';
const USER_CREDS = { XERO_OAUTH_CLIENT_ID: 'client-abc', XERO_OAUTH_CLIENT_SECRET: 'secret-xyz' };

describe('xero/oauth', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.XERO_OAUTH_REDIRECT_URI = REDIRECT_URI;
    getUserConfig.mockReturnValue({ ...USER_CREDS });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('buildAuthorizeUrl', () => {
    test('throws a clear error when the deployment-wide redirect URI is missing', () => {
      delete process.env.XERO_OAUTH_REDIRECT_URI;
      expect(() => oauth.buildAuthorizeUrl('user-1')).toThrow(/redirect uri is not configured/i);
    });

    test('throws a clear error when this specific user has no Web app credentials on file', () => {
      getUserConfig.mockReturnValue({}); // redirect URI is set (beforeEach), but this user's own client id/secret aren't
      expect(() => oauth.buildAuthorizeUrl('user-1')).toThrow(/add your xero web app/i);
    });

    test('builds a URL using THIS user\'s own client_id, not some other user\'s', () => {
      getUserConfig.mockReturnValue({ XERO_OAUTH_CLIENT_ID: 'this-users-client-id', XERO_OAUTH_CLIENT_SECRET: 'secret' });
      const url = new URL(oauth.buildAuthorizeUrl('user-1'));
      expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('this-users-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('scope')).toContain('offline_access');
      expect(url.searchParams.get('state')).toBe('fake-state-abc');
      expect(getUserConfig).toHaveBeenCalledWith('user-1');
    });

    // Xero fixes scopes at consent time, so a scope missing from this URL can
    // never be gained by an existing token — it takes a fresh reconnect. Pinning
    // the report scopes here means dropping one shows up as a test failure rather
    // than as a 401 insufficient_scope in production.
    test('requests every scope the app\'s features actually need', () => {
      getUserConfig.mockReturnValue({ XERO_OAUTH_CLIENT_ID: 'cid', XERO_OAUTH_CLIENT_SECRET: 'secret' });
      const scopes = new URL(oauth.buildAuthorizeUrl('user-1')).searchParams.get('scope').split(' ');
      for (const required of [
        'offline_access',
        'accounting.invoices', 'accounting.contacts', 'accounting.settings.read',
        'accounting.banktransactions.read', 'accounting.payments.read',
        'accounting.reports.profitandloss.read', 'accounting.reports.banksummary.read',
        'accounting.reports.budgetsummary.read', 'accounting.budgets.read',
      ]) {
        expect(scopes).toContain(required);
      }
    });
  });

  describe('exchangeCodeForTokens', () => {
    test('posts an authorization_code grant using the given user\'s own credentials', async () => {
      axios.post.mockResolvedValue({ data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800 } });
      const result = await oauth.exchangeCodeForTokens('user-1', 'the-code');
      expect(result.access_token).toBe('at-1');
      expect(result.refresh_token).toBe('rt-1');
      expect(result.expires_at).toBeInstanceOf(Date);

      const [url, body, opts] = axios.post.mock.calls[0];
      expect(url).toBe('https://identity.xero.com/connect/token');
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('the-code');
      expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
      // Basic auth is built from THIS user's client_id:client_secret
      const expectedAuth = 'Basic ' + Buffer.from(`${USER_CREDS.XERO_OAUTH_CLIENT_ID}:${USER_CREDS.XERO_OAUTH_CLIENT_SECRET}`).toString('base64');
      expect(opts.headers.Authorization).toBe(expectedAuth);
    });
  });

  describe('refreshAuthCodeToken', () => {
    test('throws when there is no refresh token on file', async () => {
      getUserConfig.mockReturnValue({ ...USER_CREDS }); // has app creds, but never completed a connection
      await expect(oauth.refreshAuthCodeToken('user-1')).rejects.toThrow(/no xero oauth connection/i);
    });

    test('persists the ROTATED refresh token Xero returns, not the old one', async () => {
      // This is the critical correctness case: Xero issues a brand new refresh token
      // on every use and immediately invalidates the previous one.
      getUserConfig.mockReturnValue({ ...USER_CREDS, XERO_OAUTH_REFRESH_TOKEN: 'old-refresh-token' });
      axios.post.mockResolvedValue({ data: { access_token: 'at-new', refresh_token: 'rt-BRAND-NEW', expires_in: 1800 } });

      await oauth.refreshAuthCodeToken('user-1');

      expect(saveUserConfig).toHaveBeenCalledWith('user-1', { XERO_OAUTH_REFRESH_TOKEN: 'rt-BRAND-NEW' });
      const [, body] = axios.post.mock.calls[0];
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-refresh-token'); // sends the OLD one to redeem
    });
  });

  describe('completeConnection', () => {
    test('exchanges the code, saves connection state, and caches every returned tenant', async () => {
      axios.post.mockResolvedValue({ data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800 } });
      axios.get.mockResolvedValue({ data: [
        { tenantId: 'tenant-1', tenantName: 'Org One' },
        { tenantId: 'tenant-2', tenantName: 'Org Two' },
      ]});
      const cacheToken = jest.fn();
      tokenCache.forUser.mockReturnValue({ cacheToken });

      const tenants = await oauth.completeConnection('user-1', 'the-code');

      expect(saveUserConfig).toHaveBeenCalledWith('user-1', expect.objectContaining({
        XERO_OAUTH_REFRESH_TOKEN: 'rt-1',
        XERO_CONNECTION_TYPE:     'oauth',
      }));
      expect(tenants).toHaveLength(2);
      expect(cacheToken).toHaveBeenCalledWith('tenant-1', 'Org One', 'at-1', expect.any(Date), 'oauth');
      expect(cacheToken).toHaveBeenCalledWith('tenant-2', 'Org Two', 'at-1', expect.any(Date), 'oauth');
    });

    test('throws a clear error when Xero returns zero authorized organisations', async () => {
      axios.post.mockResolvedValue({ data: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800 } });
      axios.get.mockResolvedValue({ data: [] });
      await expect(oauth.completeConnection('user-1', 'the-code')).rejects.toThrow(/no organisations were authorized/i);
    });
  });
});
