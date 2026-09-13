const fs   = require('fs');
const path = require('path');

// The AR / AP / Expense Claims split, pinned where it can actually be checked.
//
// There is no React test setup in this project — no jsdom, no testing-library —
// so this follows ui-api-paths.test.js and asserts against the source. That
// suits what is worth protecting here anyway: these are structural rules about
// how the page is wired, not rendering details.
//
// Three of them have already been live bugs or near-misses in this file:
// a status count taken from the whole list while the page showed one tab, a
// stale setTypeFilter left behind by the split (caught by no-undef), and a
// record type with no tab, which makes those records invisible rather than
// merely misfiled.
const ROOT       = path.join(__dirname, '../..');
const INVOICES   = path.join(ROOT, 'ui/src/pages/Invoices.jsx');
const REVIEW     = path.join(ROOT, 'ui/src/pages/InvoiceReview.jsx');
const src        = () => fs.readFileSync(INVOICES, 'utf8');

describe('AR / AP / Claims tabs — the source is the thing being read', () => {
  test('the file is present and is the page it claims to be', () => {
    expect(fs.existsSync(INVOICES)).toBe(true);
    expect(src()).toMatch(/const TABS\s*=\s*\[/);
  });
});

describe('AR / AP / Claims tabs — every record has somewhere to be', () => {
  const tabBlock = () => src().slice(src().indexOf('const TABS'), src().indexOf('const DEFAULT_TAB'));

  test('there are exactly three tabs', () => {
    const keys = [...tabBlock().matchAll(/key:\s*'([a-z]+)'/g)].map(m => m[1]);
    expect(keys).toEqual(['ar', 'ap', 'claims']);
  });

  test('each tab matches exactly one invoiceType', () => {
    const types = [...tabBlock().matchAll(/invoiceType === '([A-Z]+)'/g)].map(m => m[1]);
    expect(types).toEqual(['ACCREC', 'ACCPAY', 'EXPENSE']);
  });

  // The one that actually loses data. A fourth invoiceType introduced on the
  // server with no tab here does not misfile those records — every tab's match
  // returns false, so they appear nowhere in the UI at all.
  test('every invoiceType the server writes has a tab that shows it', () => {
    const serverTypes = new Set();
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.js$/.test(e.name) || /\.test\.js$/.test(e.name)) continue;
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/invoiceType:\s*'([A-Z]+)'/g)) {
          serverTypes.add(m[1]);
        }
      }
    };
    walk(path.join(ROOT, 'main'));

    const covered = new Set([...tabBlock().matchAll(/invoiceType === '([A-Z]+)'/g)].map(m => m[1]));
    expect(serverTypes.size).toBeGreaterThan(0);          // the scan found something
    expect([...serverTypes].filter(t => !covered.has(t))).toEqual([]);
  });
});

describe('AR / AP / Claims tabs — the labels match what Xero calls them', () => {
  // Getting these two the wrong way round is not a cosmetic slip: it presents
  // money owed TO the business as money owed BY it. The mapping is fixed by
  // Xero — ACCREC creates a customer contact and appears under Invoices,
  // ACCPAY creates a supplier contact and appears under Bills to pay — so it
  // is pinned here rather than left to whoever edits the array next. It has
  // already been renamed once by accident.
  const tabBlock = () => {
    const s = fs.readFileSync(INVOICES, 'utf8');
    return s.slice(s.indexOf('const TABS'), s.indexOf('const DEFAULT_TAB'));
  };
  const longFor = type => {
    const row = tabBlock().split('\n').find(l => l.includes(`'${type}'`));
    return row && row.match(/long:\s*'([^']+)'/)?.[1];
  };

  test('ACCREC is Invoices — raised for a customer, money coming in', () => {
    expect(longFor('ACCREC')).toBe('Invoices');
  });

  test('ACCPAY is Bills — received from a supplier, money going out', () => {
    expect(longFor('ACCPAY')).toBe('Bills');
  });

  test('the server agrees which side each type sits on', () => {
    // contacts.js is the independent check: it decides customer vs supplier from
    // the same flag, so if these ever disagree one of them is wrong.
    const contacts = fs.readFileSync(path.join(ROOT, 'main/xero/contacts.js'), 'utf8');
    expect(contacts).toMatch(/isSupplier:\s*!isACCREC/);
    expect(contacts).toMatch(/isCustomer:\s*isACCREC/);
  });
});

describe('AR / AP / Claims tabs — counts belong to the tab that shows them', () => {
  // Left over the whole list, the AR tab reads "✓ Posted 48" above three rows,
  // because it is counting posted payables too.
  test('status counts are derived from the tab rows, not the whole list', () => {
    const s = src();
    for (const name of ['pending', 'posted', 'reviewed', 'reported', 'needsAction', 'duplicates']) {
      const line = s.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
      expect(line).not.toBeNull();
      expect(line[1]).toContain('tabRows');
      expect(line[1]).not.toMatch(/\binvoices\.filter\b/);
    }
  });

  test('the tab strip counts span the whole list, so it maps the workspace', () => {
    expect(src()).toMatch(/tabCounts\s*=[\s\S]{0,160}invoices\.filter/);
  });

  test('the visible rows start from the tab, not from everything', () => {
    expect(src()).toMatch(/const filtered\s*=\s*tabRows\.filter/);
  });
});

describe('AR / AP / Claims tabs — claim controls live only on the claims tab', () => {
  // The explicit requirement: Add claim / Import claim / Use my phone belong to
  // Expense Claims and must not appear above AR or AP.
  test('ReceiptUpload is rendered exactly once', () => {
    expect((src().match(/<ReceiptUpload/g) || []).length).toBe(1);
  });

  test('that one render sits inside the claims-only gate', () => {
    const s = src();
    const gate = s.indexOf("{tab === 'claims' && (");
    const use  = s.indexOf('<ReceiptUpload');
    expect(gate).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(gate);
    // and close enough to be inside that block rather than merely after it
    expect(s.slice(gate, use)).not.toContain('</div>\n\n      {');
  });

  test('ReceiptUpload owns all three creation controls', () => {
    const upload = fs.readFileSync(path.join(ROOT, 'ui/src/components/receipts/ReceiptUpload.jsx'), 'utf8');
    expect(upload).toContain('Add claim');
    expect(upload).toContain('Import claim');
    expect(upload).toContain('Use my phone');
  });
});

describe('AR / AP / Claims tabs — the tab survives navigation', () => {
  test('the open tab is read from the URL rather than component state', () => {
    const s = src();
    expect(s).toContain('useSearchParams');
    expect(s).toMatch(/searchParams\.get\('tab'\)/);
  });

  test('switching tabs clears the selection', () => {
    // Otherwise ids ticked on AP survive into AR and a bulk delete removes the
    // wrong rows — the selection is a set of ids with no tab attached.
    const s = src();
    const setTab = s.slice(s.indexOf('const setTab'), s.indexOf('const setTab') + 420);
    expect(setTab).toMatch(/setSelected\(new Set\(\)\)/);
  });

  test('Back from a review returns to the tab that document belongs to', () => {
    const r = fs.readFileSync(REVIEW, 'utf8');
    expect(r).toContain('listPathFor');
    // No bare navigations left, which would land on the default tab instead.
    expect(r).not.toMatch(/navigate\('\/invoices'[,)]/);
  });
});
