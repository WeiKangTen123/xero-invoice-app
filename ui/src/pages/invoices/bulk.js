// Mark reviewed, Send to Xero and Delete on the selected rows: what the
// question before says, and what the answer after shows.
//
// The server decides every row (main/routes/invoices.js, POST /invoices/bulk/
// <action>) and answers each id with { ok, skipped, outcome, message }. The
// forecast here is only for the question, so "Send 12 bills?" can say that
// three of them will be skipped and why before anyone presses the button; it
// follows the same rules but the server's answer is the one that counts.
//
// Imports nothing, so main/scripts/invoice-list-view.test.js can run it as it
// is. The re-post rule comes in as an argument (repostBlockedReason, from
// xero-status.js) rather than being written out a second time.

// The server refuses more than this in one request.
export const BULK_MAX = 200;

export const BULK_ACTIONS = ['review', 'send', 'delete'];

const count = (n, tab) => `${n} ${n === 1 ? tab.one : tab.many}`;
const inXero = inv => !!inv.xeroInvoiceId || inv.status === 'posted';

// Why a row would not be acted on, in words that fit "3 …", or null.
function forecastSkip(action, inv, repostBlockedReason) {
  if (action === 'review') {
    if (inv.status === 'reviewed') return 'already reviewed';
    if (inXero(inv)) return 'already in Xero';
    if (inv.status === 'submitting') return 'being sent to Xero right now';
    if (inv.status === 'duplicate') return 'marked as duplicates (open each to confirm)';
    if (!Number(inv.totalAmount)) return 'have no amount yet (open each to fill it in)';
    return null;
  }
  if (action === 'send') {
    if (inv.status === 'submitting') return 'already being sent to Xero';
    if (inXero(inv)) {
      const locked = repostBlockedReason ? repostBlockedReason(inv) : null;
      return locked ? 'approved, paid or voided in Xero, so not changed from here' : 'already in Xero (a correction is sent from its own page)';
    }
    if (inv.status === 'review-needed') return 'need review first';
    if (inv.status === 'duplicate') return 'marked as duplicates';
    if (inv.status === 'reported') return 'reported as problems';
    if (!Number(inv.totalAmount)) return 'have no amount yet';
    return null;
  }
  if (action === 'delete') {
    if (inv.xeroInvoiceId) return 'already in Xero, so kept (void or delete those in Xero)';
    if (inv.status === 'submitting') return 'being sent to Xero right now, so kept';
    return null;
  }
  return null;
}

// { act, skips: [{ reason, n }] } for the rows about to be sent.
export function forecast(action, rows, { repostBlockedReason } = {}) {
  const skips = new Map();
  let act = 0;
  for (const inv of rows) {
    const why = forecastSkip(action, inv, repostBlockedReason);
    if (why) skips.set(why, (skips.get(why) || 0) + 1);
    else act++;
  }
  return { act, skips: [...skips.entries()].map(([reason, n]) => ({ reason, n })) };
}

// The question asked before anything happens: how many rows, what will be
// done to them, what will be left and why. `hidden` is how many selected rows
// the current filters keep off the screen, since a selection survives a
// change of filter and the action reaches those too.
export function bulkConfirm(action, rows, { tab, hidden = 0, repostBlockedReason } = {}) {
  const n = rows.length;
  const { act, skips } = forecast(action, rows, { repostBlockedReason });
  const skipLine = skips.length
    ? `${skips.map(s => `${s.n} ${s.reason}`).join('; ')}${act ? '.' : '. Nothing else is selected.'}`
    : '';
  const hiddenLine = hidden ? `${hidden} of the ${n} selected ${hidden === 1 ? 'is' : 'are'} not shown under the current filters, and ${hidden === 1 ? 'is' : 'are'} included.` : '';

  if (action === 'review') {
    return {
      title: `Mark ${count(n, tab)} reviewed?`,
      message: [
        act ? `${count(act, tab)} will be marked reviewed and move to Ready to Post. Nothing is sent to Xero.` : `None of these can be marked reviewed.`,
        skipLine && `Left as they are: ${skipLine}`,
        hiddenLine,
      ].filter(Boolean).join('\n\n'),
      confirmLabel: `Mark ${count(n, tab)} reviewed`,
      danger: false,
    };
  }
  if (action === 'send') {
    return {
      title: `Send ${count(n, tab)} to Xero?`,
      message: [
        act
          ? `${count(act, tab)} will be posted to Xero as drafts, one at a time, a few seconds apart${act > 15 ? ', so this takes a few minutes' : ''}. Each is checked for a duplicate of something already in Xero just before it goes.`
          : 'None of these can be sent from here.',
        skipLine && `Not sent: ${skipLine}`,
        hiddenLine,
      ].filter(Boolean).join('\n\n'),
      confirmLabel: `Send ${count(n, tab)}`,
      danger: false,
    };
  }
  return {
    title: `Delete ${count(n, tab)}?`,
    message: [
      act ? `${count(act, tab)} will be deleted here, with their stored PDFs and receipt photos. This cannot be undone.` : 'None of these can be deleted here.',
      skipLine && `Kept: ${skipLine}`,
      hiddenLine,
    ].filter(Boolean).join('\n\n'),
    confirmLabel: `Delete ${count(n, tab)}`,
    danger: true,
  };
}

const DONE_WORDS = {
  review: n => `Marked ${n} reviewed`,
  send:   n => `Queued ${n} for Xero`,
  delete: n => `Deleted ${n}`,
};

// "Acme Ltd · INV-104": how a row is named in the results, from the row as it
// was when the action was asked (a deleted row is gone from the list by the
// time the answer is read).
export function rowName(inv) {
  if (!inv) return 'A record no longer in the list';
  const who = inv.vendorName || 'No supplier name';
  const num = inv.invoiceNumber && inv.invoiceNumber !== '—' ? inv.invoiceNumber : null;
  return num ? `${who} · ${num}` : who;
}

// The server's answer as the results panel shows it: one headline, and the
// rows that need a word (not done first, then skipped), each named.
// Successes are a count only; two hundred lines of "Deleted" say nothing.
export function summarise(action, results, rowsById) {
  const done    = results.filter(r => r.ok && !r.skipped);
  const skipped = results.filter(r => r.ok && r.skipped);
  const failed  = results.filter(r => !r.ok);
  const parts = [];
  if (done.length) parts.push(DONE_WORDS[action](done.length));
  if (failed.length) parts.push(`${failed.length} not done`);
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  const item = r => ({
    id: r.id, ok: r.ok, skipped: !!r.skipped, name: rowName(rowsById[r.id]),
    outcome: r.outcome, message: r.message || '',
  });
  return {
    action,
    done: done.length, skipped: skipped.length, failed: failed.length,
    headline: parts.length ? parts.join(' · ') : 'Nothing was selected',
    items: [...failed.map(item), ...skipped.map(item)],
    note: action === 'send' && done.length
      ? 'Queued rows go to Xero one at a time; the list updates as each one lands.'
      : '',
  };
}

// The ids still selected afterwards: the rows that were not done, so they can
// be fixed and the same action tried again on just those.
export const stillSelected = results => results.filter(r => !r.ok).map(r => r.id);
