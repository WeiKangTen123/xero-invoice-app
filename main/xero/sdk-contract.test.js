// What the app assumes about the installed xero-node that nothing else checks.
//
// Every AccountingApi method takes its optional arguments by position, and
// the app passes them that way (`undefined, undefined, idempotencyKey`). The
// tests that check those calls (reports-contract, contacts, invoices-
// idempotency) mock the SDK, so they prove which slot the app fills but not
// what the real SDK means by that slot. An upgrade that inserted or reordered
// a parameter would send a value as something else with no error at all: the
// idempotency key as unitdp, so a retried post makes a duplicate bill, or
// standardLayout as paymentsOnly, so the P&L silently changes basis. Upgrades
// up to 20.0.0 only appended parameters at the end; these fail if one ever
// does otherwise.
//
// Nothing is called. These read the installed SDK's source and file layout.
const fs   = require('fs');
const path = require('path');
const { AccountingApi } = require('xero-node');

// The generated methods are compiled from TypeScript. Up to 7.0.0 the method
// lists its parameters plainly, `options = { headers: {} }` last; by 20.0.0 the
// outer function names them with a `_1` suffix (xeroTenantId_1) and moves the
// defaulted `options` into an inner function. Either way the order is what
// counts, so this keeps the names and drops the decoration.
function paramsOf(name) {
  const fn = AccountingApi.prototype[name];
  if (typeof fn !== 'function') throw new Error(`AccountingApi.${name} is gone`);
  const list = /^[^(]*\(([^)]*)\)/.exec(fn.toString());
  return list[1].split(',')
    .map(p => p.trim().replace(/\s*=.*$/, '').replace(/_1$/, ''))
    .filter(p => p && p !== 'options');
}

// Each method the app calls, and its parameters up to the last one any call
// site sets. Where the app passes fewer, only the leading part matters.
const USED = {
  // reports: invoices by status and date, paged, summaryOnly (index 12)
  getInvoices: ['xeroTenantId', 'ifModifiedSince', 'where', 'order', 'iDs', 'invoiceNumbers',
    'contactIDs', 'statuses', 'page', 'includeArchived', 'createdByMyApp', 'unitdp', 'summaryOnly'],
  // contacts: includeArchived, summaryOnly=false and searchTerm (6, 7, 8);
  // reports: order and page (3, 5) with summaryOnly (7)
  getContacts: ['xeroTenantId', 'ifModifiedSince', 'where', 'order', 'iDs', 'page',
    'includeArchived', 'summaryOnly', 'searchTerm'],
  // reports: where, order and page (2, 3, 4)
  getPayments:         ['xeroTenantId', 'ifModifiedSince', 'where', 'order', 'page'],
  getBankTransactions: ['xeroTenantId', 'ifModifiedSince', 'where', 'order', 'page'],
  // ageing: unallocated credit notes by where, order and page (2, 3, 4)
  getCreditNotes:      ['xeroTenantId', 'ifModifiedSince', 'where', 'order', 'page'],
  // reports: P&L by month, standardLayout=true (9) on every call
  getReportProfitAndLoss: ['xeroTenantId', 'fromDate', 'toDate', 'periods', 'timeframe',
    'trackingCategoryID', 'trackingCategoryID2', 'trackingOptionID', 'trackingOptionID2', 'standardLayout'],
  getReportBudgetSummary: ['xeroTenantId', 'date', 'periods', 'timeframe'],
  getReportBankSummary:   ['xeroTenantId', 'fromDate', 'toDate'],
  // reports: quotes from a date, paged (2, 8)
  getQuotes: ['xeroTenantId', 'ifModifiedSince', 'dateFrom', 'dateTo', 'expiryDateFrom',
    'expiryDateTo', 'contactID', 'status', 'page'],
  // invoices: the account's tax type by where; reports: by where and order
  getAccounts: ['xeroTenantId', 'ifModifiedSince', 'where', 'order'],
  // invoices: the idempotency key (4) that keeps a retried post from doubling
  createInvoices:        ['xeroTenantId', 'invoices', 'summarizeErrors', 'unitdp', 'idempotencyKey'],
  updateInvoice:         ['xeroTenantId', 'invoiceID', 'invoices'],
  getInvoiceAttachments: ['xeroTenantId', 'invoiceID'],
  createContacts:        ['xeroTenantId', 'contacts'],
  getOrganisations:      ['xeroTenantId'],
  getTaxRates:           ['xeroTenantId'],
  getBrandingThemes:     ['xeroTenantId'],
  getBudgets:            ['xeroTenantId'],
};

describe('xero/sdk-contract — argument positions the app passes', () => {
  test.each(Object.entries(USED))('%s keeps the positions the app fills', (name, expected) => {
    expect(paramsOf(name).slice(0, expected.length)).toEqual(expected);
  });

  // The two whose misplacement would do the most damage without a sound, named
  // outright so a failure says which.
  test('getReportProfitAndLoss takes standardLayout 10th, counting the tenant', () => {
    expect(paramsOf('getReportProfitAndLoss').indexOf('standardLayout')).toBe(9);
  });

  test('createInvoices takes idempotencyKey 5th, counting the tenant', () => {
    expect(paramsOf('createInvoices').indexOf('idempotencyKey')).toBe(4);
  });
});

// sdk-guard.js puts the 60-second timeout on Xero calls with an interceptor on
// the root axios, and xero-utils.js records Xero's rate-limit headers the same
// way. Both only see SDK traffic because xero-node has no axios of its own and
// loads the root one. If an upgrade's axios range ever stopped overlapping the
// app's, npm would nest a second copy under xero-node, and every Xero call
// would go out with no timeout and no rate-limit bookkeeping, with no error.
describe('xero/sdk-contract — the SDK shares the app\'s axios', () => {
  const sdkDir = path.dirname(require.resolve('xero-node/package.json'));

  test('axios required from inside xero-node is the root copy', () => {
    expect(require.resolve('axios', { paths: [path.join(sdkDir, 'dist')] })).toBe(require.resolve('axios'));
  });

  test('npm has not nested an axios under xero-node', () => {
    expect(fs.existsSync(path.join(sdkDir, 'node_modules', 'axios'))).toBe(false);
  });
});
