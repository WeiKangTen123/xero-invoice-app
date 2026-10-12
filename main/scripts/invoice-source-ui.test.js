const fs   = require('fs');
const path = require('path');

// Where a record came from, as the AR & AP list and the review page say it
// (ui/src/pages/invoices/source.js). Both read "no PDF and no photo" as "from
// an email", so an invoice typed into the form or imported from a spreadsheet
// showed "✉ Email" and "extracted from email text". There is no React test
// setup in this project, so the module, which imports nothing, is run here
// whole and the pages are checked for using it.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  if (/^import /m.test(src)) throw new Error(`${rel} now imports something; this harness runs it standalone`);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

const s = load('pages/invoices/source.js');

test('a form or spreadsheet invoice is labelled by its source in the list and on the review page; email and PDF are as before', () => {
  const inv = extra => ({ invoiceType: 'ACCREC', hasPdf: false, receiptFile: null, ...extra });

  expect(s.sourceBadge(inv({ source: 'form' }))).toMatchObject({ text: '📝 Form', short: '📝' });
  expect(s.sourceBadge(inv({ source: 'spreadsheet' }))).toMatchObject({ text: '📊 Spreadsheet', short: '📊' });
  expect(s.sourceBadge(inv({ source: 'import' })).text).toBe('📊 Spreadsheet');
  expect(s.sourceBadge(inv({ source: 'email' }))).toMatchObject({ text: '✉ Email', className: 'badge badge-gray' });
  expect(s.sourceBadge(inv({ source: 'pdf', hasPdf: true }))).toMatchObject({ text: '📄 PDF', className: 'badge badge-green' });
  expect(s.sourceBadge(inv({ source: 'phone', receiptFile: 'r.jpg' })).text).toBe('📱 Phone');
  expect(s.sourceBadge(inv({ source: 'upload', receiptFile: 'r.jpg' })).text).toBe('🧾 Receipt');

  expect(s.sourceCard(inv({ source: 'form' })).title).toBe('Entered in the form');
  expect(s.sourceCard(inv({ source: 'spreadsheet' })).title).toBe('Imported from a spreadsheet');
  expect(s.sourceCard(inv({ source: 'email' }))).toEqual({
    icon: '✉', title: 'Email Body', sub: 'No PDF attachment — invoice was extracted from email text',
  });
  expect(s.sourceLine(inv({ source: 'form' }))).toBe('Entered in the form');
  expect(s.sourceLine(inv({ source: 'spreadsheet' }))).toBe('Imported from a spreadsheet');
  expect(s.sourceLine(inv({ source: 'email' }))).toBe('Email Body');
  expect(s.sourceLine(inv({ source: 'pdf', hasPdf: true }))).toBe('PDF Attachment');

  // The pages use them, and no longer fall through to "Email" themselves.
  for (const f of ['pages/invoices/DesktopTable.jsx', 'pages/invoices/MobileList.jsx']) {
    expect(read(f)).toMatch(/claimSourceBadge\(inv\)[\s\S]{0,240}sourceBadge\(inv\)/);
    expect(read(f)).not.toContain('✉');
  }
  expect(read('pages/invoice-review/SummaryCard.jsx')).toContain('sourceLine(inv)');
  expect(read('pages/invoice-review/SummaryCard.jsx')).not.toContain("'Email Body'");
  expect(read('pages/invoice-review/EmailBodyCard.jsx')).toContain('sourceCard(inv)');
  expect(read('pages/invoice-review/EmailBodyCard.jsx')).not.toContain('extracted from email text');
});
