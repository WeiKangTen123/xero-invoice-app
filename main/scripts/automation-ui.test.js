const fs   = require('fs');
const path = require('path');

// The Automation page and the sidebar's Pipeline widget
// (ui/src/pages/automation.js), and the page's recent table
// (components/InvoiceTable.jsx). There is no React test setup in this
// project; the module imports nothing, so it is run here whole, and the
// pages are checked for using it.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  if (/^import /m.test(src)) throw new Error(`${rel} now imports something; this harness runs it standalone`);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

// The Xero row left review-needed and reviewed out, so bills waiting on a
// person read "All posted", and it said "No invoices yet" whenever none were
// pending, posted or failed, records or not.
test('the Xero figures count bills waiting on a person, and "No invoices yet" means none at all', () => {
  const a = load('pages/automation.js');
  const xero = { pending: 0, submitting: 0, posted: 4, error: 0, reviewNeeded: 3, reviewed: 1 };

  const p = a.xeroPipeline(xero);
  expect(p).toMatchObject({ total: 8, posted: 4, reviewNeeded: 3, reviewed: 1, allPosted: false, pctPosted: 50 });
  expect(a.pipelineSummary(xero, 8)).toBe('4/8 posted');
  expect(a.xeroPipeline({ posted: 2 }).allPosted).toBe(true);
  expect(a.pipelineSummary({ posted: 2 }, 2)).toBe('All posted');

  // Nothing to count: only an account with no records has no invoices.
  expect(a.pipelineEmptyText(0)).toBe('No invoices yet');
  expect(a.pipelineEmptyText(5)).toBe('Nothing waiting for Xero');
  expect(a.pipelineEmptyText(undefined)).toBeNull();
  expect(a.pipelineSummary({}, 0)).toBe('No invoices');
  expect(a.pipelineSummary({}, 5)).toBe('Nothing waiting');
  expect(a.xeroPipeline(undefined)).toMatchObject({ total: 0, allPosted: false, pctPosted: 0 });

  const page = read('pages/Dashboard.jsx');
  expect(page).toContain('label="Total records"');
  expect(page).not.toContain('since last server restart');
  expect(page).toContain('recordCount={status?.invoiceCount}');
  expect(page).not.toMatch(/xero\.pending \+ xero\.submitting \+ xero\.posted \+ xero\.error/);
  expect(read('components/layout/Sidebar.jsx')).toContain('xeroPipeline(xero)');
  expect(read('components/layout/Sidebar.jsx')).not.toMatch(/xero\.pending \+ xero\.submitting/);
});

// A mileage or per diem claim read "—" as its vendor, and the Source column
// showed the stored code ("pdf", "email-image").
test('the recent table names an allowance claim by its kind and shows the source in words', () => {
  const s = load('pages/invoices/source.js');
  expect(s.sourceWords('pdf')).toBe('PDF');
  expect(s.sourceWords('form')).toBe('Form');
  expect(s.sourceWords('email')).toBe('Email');
  expect(s.sourceWords('email-image')).toBe('Email photo');
  expect(s.sourceWords('spreadsheet')).toBe('Spreadsheet');
  expect(s.sourceWords('claim')).toBe('Claim import');
  expect(s.sourceWords(null)).toBe('—');
  expect(s.sourceWords('fax')).toBe('fax');

  const allowance = load('components/receipts/allowance.js');
  expect(allowance.claimKindLabel({ claimKind: 'mileage' })).toBe('Mileage claim');

  const table = read('components/InvoiceTable.jsx');
  expect(table).toContain('const name = inv.vendorName || claimKindLabel(inv);');
  expect(table).toContain("{name || '—'}");
  expect(table).toContain('{sourceWords(inv.source)}');
  expect(table).not.toContain("{inv.source || '—'}");
});

// The watcher runs without a Xero connection (routes/process.js), so the page
// says what happens to what it reads, and auto-submit says it is waiting.
test('with no Xero connection the watcher card says documents wait in AR & AP, and auto-submit says it is waiting', () => {
  const a = load('pages/automation.js');
  expect(a.xeroNotice({ xeroConnected: false })).toBe('Not connected: documents wait in AR & AP until you post them.');
  expect(a.xeroNotice({ xeroConnected: true })).toBeNull();
  expect(a.xeroNotice({})).toBeNull();          // a server from before the field: say nothing
  expect(a.xeroNotice(null)).toBeNull();
  expect(a.autoSubmitText(false, false)).toBe('Invoices are stored for manual review — not sent to Xero');
  expect(a.autoSubmitText(true, false)).toBe("On, but Xero isn't connected: invoices wait in AR & AP until it is");
  expect(a.autoSubmitText(true, true)).toBe('Invoices are pushed to Xero automatically on detection');
  expect(a.autoSubmitText(true, undefined)).toBe('Invoices are pushed to Xero automatically on detection');

  const page = read('pages/Dashboard.jsx');
  expect(page).toMatch(/\{xeroNotice\(status\) && \(/);
  expect(page).toContain('<Link to="/setup" className="btn btn-outline btn-sm">Connect in Setup</Link>');
  expect(page).toContain('{autoSubmitText(settings.autoProcess, status?.xeroConnected)}');
});
