// The Automation page's figures and the sidebar's Pipeline widget, from
// /api/process/status: { invoiceCount, lastActivity, xero: { pending,
// submitting, posted, error, reviewNeeded, reviewed } }.
//
// Imports nothing, so main/scripts/automation-ui.test.js can run it as it is.

const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

// What is on its way to Xero, or already there. Bills held for review and
// ones reviewed but not sent are counted: left out, a pile nobody had looked
// at read "All posted". Duplicates and reported records are not, since none
// of them is going anywhere.
//
// { posted, submitting, pending, reviewNeeded, reviewed, error, total,
//   pctPosted, pctActive, pctFailed, allPosted }
export function xeroPipeline(xero) {
  const x = {
    posted:       n(xero && xero.posted),
    submitting:   n(xero && xero.submitting),
    pending:      n(xero && xero.pending),
    reviewNeeded: n(xero && xero.reviewNeeded),
    reviewed:     n(xero && xero.reviewed),
    error:        n(xero && xero.error),
  };
  const total = x.posted + x.submitting + x.pending + x.reviewNeeded + x.reviewed + x.error;
  const pct = v => (total > 0 ? (v / total) * 100 : 0);
  return {
    ...x, total,
    pctPosted: pct(x.posted), pctActive: pct(x.submitting), pctFailed: pct(x.error),
    allPosted: total > 0 && x.posted === total,
  };
}

// What the Xero row says when it has nothing to count. "No invoices yet" only
// when the account truly has none; with records that are all duplicates or
// reported, that would be untrue. Null while the count is not known, so a
// status not loaded yet does not claim either.
export function pipelineEmptyText(recordCount) {
  if (recordCount === null || recordCount === undefined || !Number.isFinite(Number(recordCount))) return null;
  return Number(recordCount) === 0 ? 'No invoices yet' : 'Nothing waiting for Xero';
}

// The sidebar's one line: "No invoices", "All posted", "3/7 posted".
export function pipelineSummary(xero, recordCount) {
  const p = xeroPipeline(xero);
  if (p.total === 0) return Number(recordCount) > 0 ? 'Nothing waiting' : 'No invoices';
  return p.allPosted ? 'All posted' : `${p.posted}/${p.total} posted`;
}
