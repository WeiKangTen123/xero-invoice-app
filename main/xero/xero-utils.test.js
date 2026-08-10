const { _parseXeroErr, isScopeError, xeroErrMsg } = require('./xero-utils');

describe('xero/xero-utils — _parseXeroErr (pure)', () => {
  test('extracts status, body, and headers from a direct err.response shape', () => {
    const err = { response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' }, body: { Detail: 'AuthorizationUnsuccessful' } } };
    expect(_parseXeroErr(err)).toMatchObject({ status: 401, wwwAuthenticate: 'insufficient_scope', body: { Detail: 'AuthorizationUnsuccessful' } });
  });

  test('extracts the same fields from xero-node v7\'s JSON-stringified-into-err.message shape', () => {
    const err = { message: JSON.stringify({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' }, body: '{"Detail":"AuthorizationUnsuccessful"}' } }) };
    expect(_parseXeroErr(err)).toMatchObject({ status: 401, wwwAuthenticate: 'insufficient_scope', body: { Detail: 'AuthorizationUnsuccessful' } });
  });

  test('a plain Error with no Xero shape at all — zeroed status, null body, not a crash', () => {
    expect(_parseXeroErr(new Error('network down'))).toMatchObject({ status: 0, body: null, wwwAuthenticate: null });
  });
});

// Confirmed against a live call (Payments, requested without
// accounting.payments.read): Xero signals "valid token, missing scope" with
// a 401 and a WWW-Authenticate: insufficient_scope header - NOT always a
// 403, despite what an earlier version of this check assumed (and which
// silently broke the scope-aware "reconnect" messaging for bank
// transactions/reports as a result).
describe('xero/xero-utils — isScopeError', () => {
  test('a 401 with a WWW-Authenticate: insufficient_scope header is a scope error', () => {
    expect(isScopeError({ response: { statusCode: 401, headers: { 'www-authenticate': 'insufficient_scope' } } })).toBe(true);
  });

  test('a plain 401 with no insufficient_scope header is NOT a scope error (e.g. an actually invalid/expired token)', () => {
    expect(isScopeError({ response: { statusCode: 401, headers: {} } })).toBe(false);
  });

  test('a bare 403 is still treated as a scope error (defensive fallback)', () => {
    expect(isScopeError({ response: { statusCode: 403, headers: {} } })).toBe(true);
  });

  test('a 500 is not a scope error', () => {
    expect(isScopeError({ response: { statusCode: 500, headers: {} } })).toBe(false);
  });
});

describe('xero/xero-utils — xeroErrMsg', () => {
  test('a rate-limit (429) gets a friendly message regardless of body content', () => {
    expect(xeroErrMsg({ response: { statusCode: 429, body: {} } })).toMatch(/rate limit/i);
  });

  test('prefers the Xero validation error detail when present', () => {
    const err = { response: { statusCode: 400, body: { Detail: 'The fromDate and toDate parameters must be with 365 days of each other.' } } };
    expect(xeroErrMsg(err)).toBe('The fromDate and toDate parameters must be with 365 days of each other.');
  });
});
