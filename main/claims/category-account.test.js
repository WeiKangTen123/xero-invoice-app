// Which account a claim lands on, decided by its category and the org's own
// chart of accounts. Xero is mocked: the matching is the thing under test.
jest.mock('../utils/token-cache', () => ({ getPersistedTenants: jest.fn(() => []) }));
jest.mock('../xero/reports',      () => ({ getAccounts: jest.fn() }));
jest.mock('../utils/gemini-client', () => ({ callGemini: jest.fn(), GEMINI_MODELS: [] }));

const { accountForCategory, resolveAccountCode, CATEGORY_HINTS } = require('./category-account');
const { CATEGORY_NAMES } = require('./categories');
const tokenCache = require('../utils/token-cache');
const reports    = require('../xero/reports');

const acc = (code, name, type = 'EXPENSE', status = 'ACTIVE') => ({ code, name, type, status });

// The expense side of the chart Xero ships with a new Singapore org. Most
// customers never rename these, so this is the chart a claim will usually meet.
const XERO_DEFAULT = [
  acc('200', 'Sales', 'REVENUE'),
  acc('400', 'Advertising'),
  acc('404', 'Bank Fees'),
  acc('412', 'Consulting & Accounting'),
  acc('420', 'Entertainment'),
  acc('425', 'Freight & Courier'),
  acc('429', 'General Expenses'),
  acc('453', 'Office Expenses'),
  acc('461', 'Printing & Stationery'),
  acc('485', 'Subscriptions'),
  acc('489', 'Telephone & Internet'),
  acc('493', 'Travel - National'),
  acc('494', 'Travel - International'),
  acc('610', 'Accounts Receivable', 'CURRENT'),
  acc('800', 'Accounts Payable', 'CURRLIAB'),
];

beforeEach(() => {
  tokenCache.getPersistedTenants.mockReset().mockReturnValue([]);
  reports.getAccounts.mockReset();
});

describe('accountForCategory — against the chart Xero ships by default', () => {
  test.each([
    ['Entertainment/Meals', '420'],
    ['Staff Welfare',       '420'],   // no welfare account: meals go to Entertainment, as the claim guideline says
    ['Staff Overtime Meal', '420'],
    ['Local Travel',        '493'],
    ['Overtime Transport',  '493'],
    ['Overseas Travel',     '494'],
    ['Office Supplies',     '453'],   // Office Expenses, not Printing & Stationery
    ['Software/Utilities',  '485'],
    ['General Expense',     '429'],
  ])('%s → %s', (category, code) => {
    expect(accountForCategory(category, XERO_DEFAULT)).toBe(code);
  });

  test('a category the chart has nothing close to answers null, so the default stands', () => {
    expect(accountForCategory('Medical/Dental', XERO_DEFAULT)).toBeNull();
  });

  test('an unknown category, or none at all, answers null', () => {
    expect(accountForCategory('Petty Cash', XERO_DEFAULT)).toBeNull();
    expect(accountForCategory('', XERO_DEFAULT)).toBeNull();
    expect(accountForCategory(null, XERO_DEFAULT)).toBeNull();
    expect(accountForCategory(undefined, XERO_DEFAULT)).toBeNull();
  });

  test('no chart answers null', () => {
    expect(accountForCategory('Local Travel', [])).toBeNull();
    expect(accountForCategory('Local Travel', null)).toBeNull();
  });
});

describe('accountForCategory — which account is chosen', () => {
  test('a dedicated welfare account beats the entertainment fallback', () => {
    expect(accountForCategory('Staff Welfare', [...XERO_DEFAULT, acc('460', 'Staff Welfare')])).toBe('460');
  });

  test('an exact name beats one that merely contains the words', () => {
    const chart = [acc('495', 'Travel - Overseas'), acc('490', 'Travel')];
    expect(accountForCategory('Local Travel', chart)).toBe('490');
    expect(accountForCategory('Overseas Travel', chart)).toBe('495');
  });

  test('an archived account is never chosen, even when its name is the best match', () => {
    const chart = [...XERO_DEFAULT, acc('460', 'Staff Welfare', 'EXPENSE', 'ARCHIVED')];
    expect(accountForCategory('Staff Welfare', chart)).toBe('420');
  });

  test('revenue, asset and liability accounts are never chosen', () => {
    const chart = [
      acc('200', 'Entertainment Income',  'REVENUE'),
      acc('820', 'Staff Welfare Accrual', 'CURRLIAB'),
      acc('610', 'Travel Advances',       'CURRENT'),
    ];
    expect(accountForCategory('Entertainment/Meals', chart)).toBeNull();
    expect(accountForCategory('Staff Welfare',       chart)).toBeNull();
    expect(accountForCategory('Local Travel',        chart)).toBeNull();
  });

  test('an account with no type or status reported is assumed usable', () => {
    expect(accountForCategory('Entertainment/Meals', [{ code: '420', name: 'Entertainment' }])).toBe('420');
  });

  test('every category the receipt reader can return has hints', () => {
    const { SYSTEM_PROMPT } = require('../utils/receipt-parser');
    for (const category of Object.keys(CATEGORY_HINTS)) expect(SYSTEM_PROMPT).toContain(`"${category}"`);
    // and every category the reader lists is one we know how to place
    const listed = [...SYSTEM_PROMPT.matchAll(/"([A-Z][A-Za-z/ ]+)"/g)].map(m => m[1])
      .filter(c => SYSTEM_PROMPT.includes(`category: one of the following`) && /^(Entertainment|Staff|Local|Overtime|Overseas|Office|Software|Medical|General)/.test(c));
    for (const c of listed) expect(CATEGORY_HINTS).toHaveProperty(c);
  });
});

describe('resolveAccountCode — reading the chart from Xero', () => {
  test('no category: null, and Xero is never asked', async () => {
    expect(await resolveAccountCode('u1', null)).toBeNull();
    expect(await resolveAccountCode('u1', '')).toBeNull();
    expect(reports.getAccounts).not.toHaveBeenCalled();
  });

  test('no connected org: null, and Xero is never asked', async () => {
    expect(await resolveAccountCode('u1', 'Staff Welfare')).toBeNull();
    expect(reports.getAccounts).not.toHaveBeenCalled();
  });

  test('a connected org: the chart is read and the category matched', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't-1', tenantName: 'Demo' }]);
    reports.getAccounts.mockResolvedValue({ accounts: XERO_DEFAULT });
    expect(await resolveAccountCode('u1', 'Staff Welfare')).toBe('420');
    expect(reports.getAccounts).toHaveBeenCalledWith('u1', 't-1');
  });

  test('Xero failing answers null rather than throwing — the claim is still stored', async () => {
    tokenCache.getPersistedTenants.mockReturnValue([{ tenantId: 't-1' }]);
    reports.getAccounts.mockRejectedValue(new Error('rate limited'));
    await expect(resolveAccountCode('u1', 'Staff Welfare')).resolves.toBeNull();
  });
});

describe('the hint table and the reader agree', () => {
  test('the hints cover exactly the categories the reader can return', () => {
    expect(Object.keys(CATEGORY_HINTS).sort()).toEqual([...CATEGORY_NAMES].sort());
  });
});
