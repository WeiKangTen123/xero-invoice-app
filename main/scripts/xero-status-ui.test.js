const fs   = require('fs');
const path = require('path');

// The Xero status on the screen: the badge words, and the rule that offers
// Re-post only while a record is still a draft in Xero (or its status is not
// known yet). There is no React test setup in this project (see
// invoice-tabs.test.js); ui/src/pages/invoices/xero-status.js imports nothing,
// so it is run here whole, and the pages are checked for using it.
const ROOT = path.join(__dirname, '../..');
const UI   = path.join(ROOT, 'ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadXeroStatus() {
  const src = read('pages/invoices/xero-status.js');
  if (/^import /m.test(src)) throw new Error('xero-status.js now imports something; this harness runs it standalone');
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

describe('re-post gating (repostBlockedReason)', () => {
  const { repostBlockedReason } = loadXeroStatus();
  const inv = extra => ({ xeroInvoiceId: 'x-1', status: 'posted', ...extra });

  test('offered while the record is a draft in Xero, or its status is not known yet', () => {
    expect(repostBlockedReason(inv({ xeroStatus: 'DRAFT' }))).toBeNull();
    expect(repostBlockedReason(inv({ xeroStatus: null }))).toBeNull();
    expect(repostBlockedReason(inv({}))).toBeNull();
    // Not in Xero at all: a first post, not a re-post.
    expect(repostBlockedReason({ status: 'pending', xeroStatus: 'AUTHORISED' })).toBeNull();
    expect(repostBlockedReason(null)).toBeNull();
  });

  test('withheld, with the reason, once Xero has moved it on', () => {
    expect(repostBlockedReason(inv({ xeroStatus: 'AUTHORISED' }))).toBe('Approved in Xero, so it can no longer be changed from here');
    expect(repostBlockedReason(inv({ xeroStatus: 'AUTHORISED', xeroAmountPaid: 25, xeroAmountDue: 85 })))
      .toBe('Part-paid in Xero, so it can no longer be changed from here');
    expect(repostBlockedReason(inv({ xeroStatus: 'SUBMITTED' }))).toBe('Awaiting approval in Xero, so it can no longer be changed from here');
    expect(repostBlockedReason(inv({ xeroStatus: 'PAID' }))).toBe('Paid in Xero, so it can no longer be changed from here');
    expect(repostBlockedReason(inv({ xeroStatus: 'VOIDED' }))).toBe('Voided in Xero, so it can no longer be changed from here');
    expect(repostBlockedReason(inv({ xeroStatus: 'DELETED' }))).toBe('Deleted in Xero, so it can no longer be changed from here');
  });

  // The submit route refuses on the same rule (xero/status-sync.js), so a
  // page that is out of date cannot send what the button would have withheld.
  test('the screen and the server give the same answer for every status', () => {
    const { repostRefusal } = require('../xero/status-sync');
    for (const xeroStatus of [null, 'DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED']) {
      for (const xeroAmountPaid of [0, 10]) {
        for (const xeroInvoiceId of [null, 'x-1']) {
          const r = { xeroInvoiceId, xeroStatus, xeroAmountPaid, xeroAmountDue: 50 };
          expect([xeroStatus, xeroAmountPaid, xeroInvoiceId, repostBlockedReason(r)])
            .toEqual([xeroStatus, xeroAmountPaid, xeroInvoiceId, repostRefusal(r)]);
        }
      }
    }
  });
});

describe('the status badge', () => {
  const { XERO_STATUS_META, xeroStatusKey, checkedAgo, syncSummary } = loadXeroStatus();

  test('says it in the agreed words', () => {
    const labels = Object.fromEntries(Object.entries(XERO_STATUS_META).map(([k, m]) => [k, m.label]));
    expect(labels).toEqual({
      DRAFT: 'Draft in Xero', SUBMITTED: 'Awaiting approval', AUTHORISED: 'Approved', PART_PAID: 'Part-paid',
      PAID: 'Paid', VOIDED: 'Voided', DELETED: 'Deleted in Xero',
    });
  });

  test('shows nothing for a record not in Xero or not checked yet; part-paid is approved with money paid', () => {
    expect(xeroStatusKey({ xeroInvoiceId: 'x', xeroStatus: null })).toBeNull();
    expect(xeroStatusKey({ xeroStatus: 'PAID' })).toBeNull();
    expect(xeroStatusKey({ xeroInvoiceId: 'x', xeroStatus: 'AUTHORISED', xeroAmountPaid: 0 })).toBe('AUTHORISED');
    expect(xeroStatusKey({ xeroInvoiceId: 'x', xeroStatus: 'AUTHORISED', xeroAmountPaid: 1, xeroAmountDue: 9 })).toBe('PART_PAID');
  });

  test('says how long ago Xero was asked', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(checkedAgo(null, now)).toBeNull();
    expect(checkedAgo('2026-10-08T11:59:30Z', now)).toBe('checked just now');
    expect(checkedAgo('2026-10-08T11:20:00Z', now)).toBe('checked 40 min ago');
    expect(checkedAgo('2026-10-08T09:00:00Z', now)).toBe('checked 3 hours ago');
    expect(checkedAgo('2026-10-06T12:00:00Z', now)).toBe('checked 2 days ago');
  });

  test("the Refresh result in words, saying when a company could not be read", () => {
    expect(syncSummary({ checked: 12, updated: 3, failedTenants: 0 })).toBe('Checked 12 records in Xero: 3 changed.');
    expect(syncSummary({ checked: 1, updated: 0, failedTenants: 0 })).toBe('Checked 1 record in Xero: nothing changed.');
    expect(syncSummary({ checked: 4, updated: 0, failedTenants: 1 })).toMatch(/One Xero company could not be read this time/);
  });
});

describe('the pages use it', () => {
  test('both re-post buttons are disabled by the rule, with the reason as their title', () => {
    for (const f of ['pages/invoice-review/TopBar.jsx', 'pages/invoice-review/StickyActionBar.jsx']) {
      const src = read(f);
      expect(src).toContain('disabled={submitting || !!repostLocked}');
      expect(src).toMatch(/title=\{repostLocked \|\|/);
    }
    const page = read('pages/InvoiceReview.jsx');
    expect(page).toContain('const repostLocked = repostBlockedReason(inv);');
    expect((page.match(/repostLocked=\{repostLocked\}/g) || []).length).toBe(2);
  });

  test('the badge is on list rows, mobile rows and the review page', () => {
    for (const f of ['pages/invoices/DesktopTable.jsx', 'pages/invoices/MobileList.jsx', 'pages/invoice-review/TopBar.jsx']) {
      expect(read(f)).toContain('<XeroStatusBadge invoice={inv}');
    }
  });

  test('the AR & AP page has a Refresh from Xero button that calls the endpoint', () => {
    const src = read('pages/Invoices.jsx');
    expect(src).toContain("api.post('/invoices/sync-xero-status'");
    expect(src).toContain('Refresh from Xero');
  });
});
