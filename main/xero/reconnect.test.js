jest.mock('../utils/users', () => ({ getUserConfig: jest.fn() }));
jest.mock('./connect', () => ({ autoConnect: jest.fn() }));
jest.mock('./oauth',   () => ({ reconnect: jest.fn() }));

const { getUserConfig } = require('../utils/users');
const { autoConnect }   = require('./connect');
const { reconnect: oauthReconnect } = require('./oauth');
const { reconnectXero } = require('./reconnect');

describe('reconnectXero', () => {
  beforeEach(() => jest.clearAllMocks());

  test('dispatches to xero/oauth.reconnect when the user is on the oauth connection type', async () => {
    getUserConfig.mockReturnValue({ XERO_CONNECTION_TYPE: 'oauth' });
    oauthReconnect.mockResolvedValue(['tenant-1']);

    const result = await reconnectXero('user-1');

    expect(oauthReconnect).toHaveBeenCalledWith('user-1');
    expect(autoConnect).not.toHaveBeenCalled();
    expect(result).toEqual(['tenant-1']);
  });

  test('dispatches to xero/connect.autoConnect when the user is on the custom connection type', async () => {
    getUserConfig.mockReturnValue({ XERO_CONNECTION_TYPE: 'custom' });
    autoConnect.mockResolvedValue(['tenant-2']);

    await reconnectXero('user-2');

    expect(autoConnect).toHaveBeenCalledWith('user-2');
    expect(oauthReconnect).not.toHaveBeenCalled();
  });

  test('defaults to autoConnect (custom) when no connection type is on file yet', () => {
    getUserConfig.mockReturnValue({});
    reconnectXero('user-3');
    expect(autoConnect).toHaveBeenCalledWith('user-3');
  });
});
