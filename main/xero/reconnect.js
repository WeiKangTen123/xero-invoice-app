// Dispatches to whichever Xero connection method a user actually has active, so
// callers that just need "make sure this user has a live Xero connection" (invoice
// submission's reconnect-on-empty-cache path) don't need to know or care which one.
async function reconnectXero(userId) {
  const { getUserConfig } = require('../utils/users');
  const config = getUserConfig(userId);
  return config.XERO_CONNECTION_TYPE === 'oauth'
    ? require('./oauth').reconnect(userId)
    : require('./connect').autoConnect(userId);
}

module.exports = { reconnectXero };
