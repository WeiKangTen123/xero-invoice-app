const fs   = require('fs');
const path = require('path');

// The AR & AP list's due dates, overdue rule, sort order, CSV export and the
// words around bulk actions. There is no React test setup in this project
// (see invoice-tabs.test.js), so the rules live in plain modules that import
// nothing, and each is run here whole, as xero-status-ui.test.js does.
const ROOT = path.join(__dirname, '../..');
const UI   = path.join(ROOT, 'ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  if (/^import /m.test(src)) throw new Error(`${rel} now imports something; this harness runs it standalone`);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

const view = load('pages/invoices/list-view.js');
const csv  = load('pages/invoices/csv.js');
const bulk = load('pages/invoices/bulk.js');
const { repostBlockedReason } = load('pages/invoices/xero-status.js');

const bill = extra => ({ id: 'b', invoiceType: 'ACCPAY', status: 'posted', dueDate: '2026-10-08', ...extra });

describe('today, where the person is', () => {
  // 16:30 UTC on the 8th is already 00:30 on the 9th in Singapore, and still
  // the 8th in London and New York.
  const instant = new Date('2026-10-08T16:30:00Z');

  test('is the calendar day in the account timezone, not UTC or the server', () => {
    expect(view.todayIn('Asia/Singapore', instant)).toBe('2026-10-09');
    expect(view.todayIn('UTC', instant)).toBe('2026-10-08');
    expect(view.todayIn('Europe/London', instant)).toBe('2026-10-08');
    expect(view.todayIn('America/New_York', new Date('2026-10-09T03:00:00Z'))).toBe('2026-10-08');
  });

  test('an unknown timezone falls back to the device day rather than failing', () => {
    expect(view.todayIn('Not/AZone', instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('the same bill, at the same moment, is overdue in Singapore and not yet in London', () => {
    const due8th = bill({ dueDate: '2026-10-08' });
    expect(view.overdueDays(due8th, view.todayIn('Asia/Singapore', instant))).toBe(1);
    expect(view.overdueDays(due8th, view.todayIn('Europe/London', instant))).toBe(0);
  });
});

describe('overdue', () => {
  test('starts the day after the due date, counted in whole calendar days', () => {
    expect(view.overdueDays(bill(), '2026-10-07')).toBe(0);
    expect(view.overdueDays(bill(), '2026-10-08')).toBe(0);           // due today is not overdue
    expect(view.overdueDays(bill(), '2026-10-09')).toBe(1);
    expect(view.overdueDays(bill(), '2026-10-20')).toBe(12);
    // Across a month, a year, and a daylight-saving change.
    expect(view.overdueDays(bill({ dueDate: '2026-12-31' }), '2027-01-02')).toBe(2);
    expect(view.overdueDays(bill({ dueDate: '2026-03-07' }), '2026-03-09')).toBe(2);
    expect(view.overdueDays(bill({ dueDate: '2026-10-25' }), '2026-10-27')).toBe(2);
  });

  test('says it in words, red only once it is overdue', () => {
    expect(view.dueInfo(bill(), '2026-10-20')).toEqual({ date: '2026-10-08', label: 'Overdue 12 days', overdue: true });
    expect(view.dueInfo(bill(), '2026-10-09')).toEqual({ date: '2026-10-08', label: 'Overdue 1 day', overdue: true });
    expect(view.dueInfo(bill(), '2026-10-08')).toEqual({ date: '2026-10-08', label: 'Due today', overdue: false });
    expect(view.dueInfo(bill(), '2026-10-01')).toEqual({ date: '2026-10-08', label: '2026-10-08', overdue: false });
  });

  test('paid, voided or deleted in Xero is never overdue', () => {
    for (const xeroStatus of ['PAID', 'VOIDED', 'DELETED']) {
      expect(view.overdueDays(bill({ xeroInvoiceId: 'x', xeroStatus }), '2026-11-01')).toBe(0);
      expect(view.dueInfo(bill({ xeroInvoiceId: 'x', xeroStatus }), '2026-11-01').overdue).toBe(false);
    }
  });

  test('anything else in Xero is still owed, part-paid included', () => {
    for (const xeroStatus of ['DRAFT', 'SUBMITTED', 'AUTHORISED']) {
      expect(view.overdueDays(bill({ xeroInvoiceId: 'x', xeroStatus }), '2026-10-10')).toBe(2);
    }
    expect(view.overdueDays(bill({ xeroInvoiceId: 'x', xeroStatus: 'AUTHORISED', xeroAmountPaid: 5, xeroAmountDue: 5 }), '2026-10-10')).toBe(2);
  });

  test('a record not in Xero yet, or not checked yet, counts as unpaid', () => {
    expect(view.overdueDays(bill({ status: 'pending' }), '2026-10-10')).toBe(2);
    expect(view.overdueDays(bill({ xeroInvoiceId: 'x', xeroStatus: null }), '2026-10-10')).toBe(2);
    expect(view.overdueDays({ invoiceType: 'ACCREC', status: 'reviewed', dueDate: '2026-10-01' }, '2026-10-10')).toBe(9);
  });

  test('expense claims have no due date: nothing shown, never overdue', () => {
    const claim = { invoiceType: 'EXPENSE', status: 'pending', dueDate: '2026-01-01' };
    expect(view.overdueDays(claim, '2026-10-10')).toBe(0);
    expect(view.dueInfo(claim, '2026-10-10')).toBeNull();
  });

  test('no due date, or one that is not a real date, is not overdue', () => {
    expect(view.overdueDays(bill({ dueDate: null }), '2026-10-10')).toBe(0);
    expect(view.overdueDays(bill({ dueDate: '2026-02-30' }), '2026-10-10')).toBe(0);
    expect(view.overdueDays(bill({ dueDate: 'soon' }), '2026-10-10')).toBe(0);
    expect(view.dueInfo(bill({ dueDate: null }), '2026-10-10')).toEqual({ date: null, label: '—', overdue: false });
    // A stored timestamp is read for its day.
    expect(view.overdueDays(bill({ dueDate: '2026-10-01T00:00:00.000Z' }), '2026-10-10')).toBe(9);
  });

  test('a duplicate is not counted, so one debt is not shown twice', () => {
    expect(view.overdueDays(bill({ status: 'duplicate', xeroInvoiceId: null }), '2026-10-20')).toBe(0);
  });
});

describe('sorting', () => {
  const ids = rows => rows.map(r => r.id);

  test('reads and writes the URL form, and ignores anything else', () => {
    expect(view.parseSort('due-asc')).toEqual({ key: 'due', dir: 'asc' });
    expect(view.parseSort('amount-desc')).toEqual({ key: 'amount', dir: 'desc' });
    for (const bad of [null, '', 'due', 'due-up', 'price-asc', 'DUE-ASC']) expect(view.parseSort(bad)).toBeNull();
    expect(view.formatSort({ key: 'due', dir: 'asc' })).toBe('due-asc');
    expect(view.formatSort(null)).toBe('');
  });

  test('a column click goes: its usual direction, the other way, then back to arrival order', () => {
    let s = view.nextSort(null, 'due');
    expect(s).toEqual({ key: 'due', dir: 'asc' });
    s = view.nextSort(s, 'due');
    expect(s).toEqual({ key: 'due', dir: 'desc' });
    expect(view.nextSort(s, 'due')).toBeNull();
    expect(view.nextSort(s, 'amount')).toEqual({ key: 'amount', dir: 'desc' });
    expect(view.nextSort(null, 'date')).toEqual({ key: 'date', dir: 'desc' });
    expect(view.sortLabel({ key: 'due', dir: 'asc' })).toBe('Due, earliest first');
  });

  test('rows with nothing to sort by go last, whichever way round', () => {
    const rows = [
      { id: 'none', totalAmount: null }, { id: 'ten', totalAmount: 10 },
      { id: 'blank', totalAmount: '' }, { id: 'five', totalAmount: 5 }, { id: 'big', totalAmount: 1200.5 },
    ];
    expect(ids(view.sortRows(rows, { key: 'amount', dir: 'desc' }))).toEqual(['big', 'ten', 'five', 'none', 'blank']);
    expect(ids(view.sortRows(rows, { key: 'amount', dir: 'asc' }))).toEqual(['five', 'ten', 'big', 'none', 'blank']);
  });

  test('stable: rows that tie keep the order they came in, both directions', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, invoiceType: 'ACCPAY', dueDate: i % 2 ? '2026-10-01' : '2026-10-05' }));
    expect(ids(view.sortRows(rows, { key: 'due', dir: 'asc' }))).toEqual(['b', 'd', 'a', 'c', 'e']);
    expect(ids(view.sortRows(rows, { key: 'due', dir: 'desc' }))).toEqual(['a', 'c', 'e', 'b', 'd']);
    // And the same answer however many times it is asked.
    expect(ids(view.sortRows(view.sortRows(rows, { key: 'due', dir: 'asc' }), { key: 'due', dir: 'asc' }))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  test('due: expense claims and missing dates last', () => {
    const rows = [
      { id: 'claim', invoiceType: 'EXPENSE', dueDate: '2020-01-01' },
      { id: 'late',  invoiceType: 'ACCPAY',  dueDate: '2026-11-01' },
      { id: 'none',  invoiceType: 'ACCPAY',  dueDate: null },
      { id: 'early', invoiceType: 'ACCREC',  dueDate: '2026-09-01' },
    ];
    expect(ids(view.sortRows(rows, { key: 'due', dir: 'asc' }))).toEqual(['early', 'late', 'claim', 'none']);
    expect(ids(view.sortRows(rows, { key: 'due', dir: 'desc' }))).toEqual(['late', 'early', 'claim', 'none']);
  });

  test('supplier/customer: ignores case and accents, reads numbers as numbers, blanks last', () => {
    const rows = [{ id: 'z', vendorName: 'zeta' }, { id: 'v10', vendorName: 'Vendor 10' }, { id: 'none', vendorName: '  ' },
                  { id: 'v2', vendorName: 'Vendor 2' }, { id: 'acc', vendorName: 'Ábc' }, { id: 'a', vendorName: 'abc' }];
    expect(ids(view.sortRows(rows, { key: 'contact', dir: 'asc' }))).toEqual(['acc', 'a', 'v2', 'v10', 'z', 'none']);
  });

  test('date and status', () => {
    const rows = [{ id: 'old', invoiceDate: '2026-01-02', status: 'posted' }, { id: 'new', invoiceDate: '2026-10-01', status: 'review-needed' },
                  { id: 'mid', invoiceDate: '2026-05-05', status: 'pending' }, { id: 'odd', invoiceDate: null, status: 'mystery' }];
    expect(ids(view.sortRows(rows, { key: 'date', dir: 'desc' }))).toEqual(['new', 'mid', 'old', 'odd']);
    expect(ids(view.sortRows(rows, { key: 'status', dir: 'asc' }))).toEqual(['new', 'mid', 'old', 'odd']);
  });

  test('leaves the rows it was given alone', () => {
    const rows = [{ id: 'b', totalAmount: 2 }, { id: 'a', totalAmount: 1 }];
    view.sortRows(rows, { key: 'amount', dir: 'asc' });
    expect(ids(rows)).toEqual(['b', 'a']);
    expect(view.sortRows(rows, null)).not.toBe(rows);
  });
});

describe('CSV export', () => {
  test('starts with a byte order mark and ends lines with CRLF', () => {
    const out = csv.toCsv([['a', 'b'], ['c', 'd']]);
    expect(out.charCodeAt(0)).toBe(0xFEFF);
    expect(out).toBe('﻿a,b\r\nc,d\r\n');
  });

  test('quotes what needs quoting and doubles quotes inside', () => {
    expect(csv.csvCell('plain')).toBe('plain');
    expect(csv.csvCell('Smith, Jones & Co')).toBe('"Smith, Jones & Co"');
    expect(csv.csvCell('The "Best" Ltd')).toBe('"The ""Best"" Ltd"');
    expect(csv.csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csv.csvCell('a\r\nb')).toBe('"a\r\nb"');
    expect(csv.csvCell(null)).toBe('');
    expect(csv.csvCell(undefined)).toBe('');
    expect(csv.csvCell(0)).toBe('0');
    expect(csv.csvCell('Café ¥')).toBe('Café ¥');
  });

  test('a cell a spreadsheet would run as a formula is written as text', () => {
    expect(csv.csvCell('=HYPERLINK("http://x","click")')).toBe('"\'=HYPERLINK(""http://x"",""click"")"');
    expect(csv.csvCell('+1+1')).toBe("'+1+1");
    expect(csv.csvCell('-2+3')).toBe("'-2+3");
    expect(csv.csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csv.csvCell('\tcmd')).toBe("'\tcmd");
    expect(csv.csvCell('=1,2')).toBe('"\'=1,2"');
    // A plain number stays a number, so a credit's -12.50 still adds up.
    expect(csv.csvCell('-12.50')).toBe('-12.50');
    expect(csv.csvCell(-5)).toBe('-5');
    expect(csv.csvCell('Acme = Best')).toBe('Acme = Best');
  });

  test('one row per record, in the columns asked for', () => {
    const rows = [
      { invoiceDate: '2026-09-01', dueDate: '2026-10-01', invoiceType: 'ACCPAY', vendorName: 'Acme, Ltd', invoiceNumber: '=cmd',
        currency: 'SGD', subTotal: 100, taxAmount: 9, totalAmount: 109, status: 'posted', xeroInvoiceId: 'x', xeroStatus: 'AUTHORISED',
        xeroAmountPaid: 9, xeroAmountDue: 100, xeroPaidOn: null, accountCode: '400' },
      { invoiceDate: '2026-09-02', dueDate: '2026-09-30', invoiceType: 'EXPENSE', vendorName: 'Grab', invoiceNumber: null,
        currency: 'SGD', subTotal: null, taxAmount: null, totalAmount: 12.3, status: 'review-needed' },
    ];
    const label = inv => (inv.xeroStatus === 'AUTHORISED' && inv.xeroAmountPaid > 0 ? 'Part-paid' : '');
    const lines = csv.invoiceCsv(rows, { xeroStatusLabel: label }).slice(1).split('\r\n');
    expect(lines[0]).toBe('Date,Due,Type,Supplier/Customer,Number,Currency,Subtotal,Tax,Total,Status,Xero status,Amount due,Paid on,Account code');
    expect(lines[1]).toBe('2026-09-01,2026-10-01,Bill,"Acme, Ltd",\'=cmd,SGD,100.00,9.00,109.00,Posted,Part-paid,100.00,,400');
    // A claim has no due date, as on screen.
    expect(lines[2]).toBe('2026-09-02,,Expense claim,Grab,,SGD,,,12.30,Needs review,,,,');
    expect(lines[3]).toBe('');
    expect(lines).toHaveLength(4);
  });

  test('is named for the tab and the day', () => {
    expect(csv.csvFilename('bills', '2026-10-08')).toBe('invoices-bills-2026-10-08.csv');
    expect(csv.csvFilename('expense claims', '2026-10-08')).toBe('invoices-expense-claims-2026-10-08.csv');
    expect(csv.csvFilename('invoices', '2026-10-08')).toBe('invoices-invoices-2026-10-08.csv');
  });
});

describe('bulk actions: the question and the answer', () => {
  const tab = { one: 'bill', many: 'bills' };

  test('the cap is the server\'s', () => {
    const server = fs.readFileSync(path.join(ROOT, 'main/routes/invoices.js'), 'utf8');
    expect(Number(server.match(/const BULK_MAX = (\d+);/)[1])).toBe(bulk.BULK_MAX);
    expect(bulk.BULK_MAX).toBe(200);
  });

  test('send: says how many go and why the rest will not, before anything is sent', () => {
    const rows = [
      { id: '1', status: 'pending', totalAmount: 10 },
      { id: '2', status: 'reviewed', totalAmount: 10 },
      { id: '3', status: 'review-needed', totalAmount: 10 },
      { id: '4', status: 'posted', xeroInvoiceId: 'x', xeroStatus: 'DRAFT', totalAmount: 10 },
      { id: '5', status: 'posted', xeroInvoiceId: 'y', xeroStatus: 'PAID', totalAmount: 10 },
    ];
    const q = bulk.bulkConfirm('send', rows, { tab, repostBlockedReason });
    expect(q.title).toBe('Send 5 bills to Xero?');
    expect(q.confirmLabel).toBe('Send 5 bills');
    expect(q.danger).toBe(false);
    expect(q.message).toMatch(/^2 bills will be posted to Xero as drafts, one at a time/);
    expect(q.message).toMatch(/1 need review first/);
    expect(q.message).toMatch(/1 already in Xero/);
    expect(q.message).toMatch(/1 approved, paid or voided in Xero/);
  });

  test('delete is the dangerous one, and names what is kept; hidden rows are mentioned', () => {
    const rows = [{ id: '1', status: 'pending' }, { id: '2', status: 'posted', xeroInvoiceId: 'x' }];
    const q = bulk.bulkConfirm('delete', rows, { tab, hidden: 1 });
    expect(q.danger).toBe(true);
    expect(q.title).toBe('Delete 2 bills?');
    expect(q.message).toMatch(/1 bill will be deleted here/);
    expect(q.message).toMatch(/Kept: 1 already in Xero/);
    expect(q.message).toMatch(/1 of the 2 selected is not shown under the current filters/);
  });

  test('review: counts what moves to Ready to Post', () => {
    const q = bulk.bulkConfirm('review', [{ id: '1', status: 'pending', totalAmount: 5 }, { id: '2', status: 'reviewed', totalAmount: 5 }], { tab });
    expect(q.title).toBe('Mark 2 bills reviewed?');
    expect(q.message).toMatch(/^1 bill will be marked reviewed/);
    expect(q.message).toMatch(/1 already reviewed/);
  });

  test('the answer: successes as a count, the rest listed by row, not-done first', () => {
    const results = [
      { id: 'a', ok: true,  skipped: false, outcome: 'Queued for Xero', message: '' },
      { id: 'b', ok: true,  skipped: true,  outcome: 'Already in Xero', message: 'Not sent again.' },
      { id: 'c', ok: false, skipped: false, outcome: 'Needs review first', message: 'No amount was read.' },
      { id: 'd', ok: true,  skipped: false, outcome: 'Queued for Xero', message: '' },
    ];
    const rowsById = { a: { vendorName: 'A' }, b: { vendorName: 'Bee Co', invoiceNumber: 'B-1' }, c: { vendorName: 'Cee', invoiceNumber: '—' } };
    const r = bulk.summarise('send', results, rowsById);
    expect(r.headline).toBe('Queued 2 for Xero · 1 not done · 1 skipped');
    expect(r.items.map(i => [i.id, i.name, i.outcome])).toEqual([
      ['c', 'Cee', 'Needs review first'],
      ['b', 'Bee Co · B-1', 'Already in Xero'],
    ]);
    expect(r.note).toMatch(/one at a time/);
    expect(bulk.stillSelected(results)).toEqual(['c']);
    expect(bulk.summarise('delete', [{ id: 'z', ok: true, skipped: false, outcome: 'Deleted' }], {}).headline).toBe('Deleted 1');
    expect(bulk.rowName(undefined)).toBe('A record no longer in the list');
  });
});

describe('the page uses them', () => {
  const page = () => read('pages/Invoices.jsx');

  test('one request per bulk action, to the bulk routes', () => {
    expect(page()).toContain('api.post(`/invoices/bulk/${action}`, { ids })');
    // The old way was one DELETE per selected row.
    expect(page()).not.toMatch(/Promise\.allSettled\(ids\.map/);
  });

  test('the sort lives in the URL, per tab, like the filters', () => {
    expect(page()).toContain('const sortParam = `sort_${tab}`;');
    expect(page()).toMatch(/setParam\(sortParam, formatSort\(s\)\)/);
  });

  test('the CSV is the rows on screen, in their order', () => {
    expect(page()).toMatch(/function handleExportCsv\(\) \{\s*const rows = groups\.flatMap\(g => g\.rows\);/);
  });

  test('Due column on the desktop table, due line on phone rows', () => {
    expect(read('pages/invoices/DesktopTable.jsx')).toContain('<SortHeader field="due" label="Due"');
    expect(read('pages/invoices/MobileList.jsx')).toContain('dueInfo(inv, today)');
  });

  test('the Overdue pill counts the open tab only', () => {
    expect(page()).toMatch(/const overdue\s*=\s*tabRows\.filter/);
  });
});
