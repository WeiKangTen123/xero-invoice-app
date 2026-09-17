// Which account a claim belongs to, decided by what the receipt was for.
//
// Every claim used to land on one account — the user's DEFAULT_ACCOUNT_CODE —
// so a bakery run and a client dinner and a Grab ride all posted to the same
// line. The receipt reader already names a category ("Staff Welfare"), and an
// org's own chart of accounts already names the accounts, so the two can be
// matched instead of guessed.
//
// Matching is against the org's real account names read from Xero. Nothing is
// invented: no match means the default stands. Codes are never hardcoded —
// "429" is General Expenses in one org and something else in the next.

const logger = require('../utils/logger');
const { CATEGORY_NAMES } = require('./categories');

// Ordered from most specific to least. First name that contains one of these
// wins, so "Staff Welfare" beats a bare "Welfare" only because it is asked for
// first. Every list ends with terms broad enough to catch a plainly-named
// chart, and narrow enough not to catch an unrelated account.
const CATEGORY_HINTS = {
  'Entertainment/Meals':  ['entertainment', 'meals', 'client entertainment', 'hospitality'],
  // Most charts have no welfare line at all; the claim guideline puts staff
  // meals on the Entertainment account in that case, so it is the last resort.
  'Staff Welfare':        ['staff welfare', 'welfare', 'staff amenities', 'pantry', 'staff refreshment', 'entertainment'],
  'Staff Overtime Meal':  ['overtime meal', 'staff welfare', 'welfare', 'meals', 'entertainment'],
  'Local Travel':         ['local travel', 'transport', 'travel - local', 'taxi', 'mileage', 'travel'],
  'Overtime Transport':   ['overtime transport', 'local travel', 'transport', 'taxi', 'travel'],
  'Overseas Travel':      ['overseas travel', 'travel - overseas', 'travel - international', 'airfare', 'accommodation', 'travel'],
  'Office Supplies':      ['office supplies', 'office expenses', 'stationery', 'printing & stationery', 'consumables'],
  'Software/Utilities':   ['software', 'subscriptions', 'it expenses', 'computer', 'hosting', 'utilities'],
  'Medical/Dental':       ['medical', 'dental', 'health', 'insurance - medical'],
  'General Expense':      ['general expenses', 'sundry', 'miscellaneous'],
};
// The hints and the reader's list must agree, or a category the reader can
// return would silently fall through to the default account.
for (const name of Object.keys(CATEGORY_HINTS)) {
  if (!CATEGORY_NAMES.includes(name)) throw new Error(`CATEGORY_HINTS names "${name}", which claims/categories.js does not list`);
}

// A claim is a cost. Revenue, assets and liabilities are never the answer, and
// an archived account cannot be posted to.
const EXPENSE_TYPES = ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS', 'DEPRECIATN'];

function _usable(a) {
  const status = String(a.status || '').toUpperCase();
  const type   = String(a.type || '').toUpperCase();
  return a.code && (!status || status === 'ACTIVE') && (!type || EXPENSE_TYPES.includes(type));
}

// The account code for a category, or null when the chart has nothing close.
function accountForCategory(category, accounts) {
  const hints = CATEGORY_HINTS[String(category || '').trim()];
  if (!hints || !Array.isArray(accounts) || !accounts.length) return null;

  const usable = accounts.filter(_usable).map(a => ({ code: String(a.code), name: String(a.name || '').toLowerCase() }));
  if (!usable.length) return null;

  for (const hint of hints) {
    // An exact name beats one that merely contains the words, so a chart with
    // both "Travel" and "Travel - Overseas" resolves the way it reads.
    const exact = usable.find(a => a.name === hint);
    if (exact) return exact.code;
    const partial = usable.find(a => a.name.includes(hint));
    if (partial) return partial.code;
  }
  return null;
}

// Reads the org's chart of accounts (a cached GET; no write of any kind) and
// answers with a code, or null. Never throws: a claim must be storable whether
// or not Xero is connected.
async function resolveAccountCode(userId, category) {
  if (!category) return null;
  try {
    const tokenCache = require('../utils/token-cache');
    const tenants    = tokenCache.getPersistedTenants(userId) || [];
    if (!tenants.length) return null;

    const reports  = require('../xero/reports');
    const { accounts } = await reports.getAccounts(userId, tenants[0].tenantId);
    const code = accountForCategory(category, accounts);
    if (code) logger.info('Claim account chosen from category', { userId, category, code });
    return code;
  } catch (err) {
    logger.warn('Could not resolve an account for the claim category', { userId, category, error: err.message });
    return null;
  }
}

module.exports = { accountForCategory, resolveAccountCode, CATEGORY_HINTS };
