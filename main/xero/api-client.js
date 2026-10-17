const { AccountingApi } = require('xero-node');

// The one place a Xero API client is made. Every module that reaches Xero —
// posting (invoices.js, contacts.js), the reports (report-fetch.js and the
// report modules through its _apiFor), the status read-back (status-sync.js)
// and live updates (change-detector.js) — asks here with the token the token
// cache gave it, and gets back something with the AccountingApi's methods.
//
// For a real token that is the SDK's AccountingApi, constructed from
// 'xero-node' as each module used to do itself, so a test that replaces the
// SDK (jest.mock('xero-node')) still replaces what every module runs against.
//
// For a demo account's token (utils/token-cache.js mints 'demo:<userId>' for
// one; it never holds a Xero token) it is the demo facade (xero/demo/api.js):
// the same methods and positional arguments, answered from the generated Demo
// Company, so the dashboard, the checks, posting and the status sync run
// unchanged against it. api-client.test.js scans main/ to keep every
// `new AccountingApi(` here, since a module that made its own would send a
// demo account's token to Xero.
//
// The demo folder is required at call time, not at load: it builds a
// company's worth of data and reads the users table, and this module is
// loaded by everything that touches Xero.
function _demo() {
  return require('./demo/api');
}

function isDemoToken(token) {
  return _demo().isDemoToken(token);
}

function apiFor(token) {
  const demo = _demo();
  if (demo.isDemoToken(token)) return demo.demoApiFor(demo.userIdFromDemoToken(token));
  const api = new AccountingApi();
  api.accessToken = token;
  return api;
}

module.exports = { apiFor, isDemoToken };
