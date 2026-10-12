// The lines under the three cards at the top of the Dashboard: how many
// invoices and bills are awaiting payment, how many are past due, and whether
// credit notes were taken off the totals. "0 sales invoices awaiting payment"
// and "0 invoices and 0 bills past due" read as counts of something; when
// there is nothing, the card says so.
//
// Plain functions with no imports, so main/scripts/dashboard-cards-ui.test.js
// can load and run them; the page (XeroInsights.jsx) only lays them out.

const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Receivables (`side` 'receivables') or payables, by count. The phone's
// three-across cards leave room for a few words, so it is shorter there.
export function awaitingLine(side, count, isMobile = false) {
  const n = Number(count) || 0;
  if (!n) return isMobile ? 'Nothing owed' : 'Nothing awaiting payment';
  if (side === 'payables') return isMobile ? counted(n, 'bill', 'bills') : `${counted(n, 'bill', 'bills')} awaiting payment`;
  return isMobile ? counted(n, 'invoice', 'invoices') : `${counted(n, 'sales invoice', 'sales invoices')} awaiting payment`;
}

// The Overdue card's two counts. A side with none is left out rather than
// counted as zero; with neither, nothing is past due.
export function overdueLine(invoices, bills, isMobile = false) {
  const i = Number(invoices) || 0;
  const b = Number(bills) || 0;
  if (!i && !b) return 'Nothing past due';
  const inv  = isMobile ? `${i} inv` : counted(i, 'invoice', 'invoices');
  const bill = counted(b, 'bill', 'bills');
  if (isMobile && i && b) return `${inv} · ${bill}`;
  return `${[i && inv, b && bill].filter(Boolean).join(' and ')} past due`;
}

// The note under the Receivables or Payables card about credit notes, or null.
// The summary nets open credit notes off each side's total (`creditsNetted`,
// one amount per side), which the total alone does not say; and when they
// could not be read, the total is before any, which it must say instead.
// `fmt` formats an amount in the organisation's currency.
export function creditLine(kpis, side, fmt, isMobile = false) {
  if (kpis?.creditsUnavailable === true) return 'credit notes not read';
  const v = Number(kpis?.creditsNetted?.[side]);
  if (!(v > 0)) return null;
  return isMobile ? `after ${fmt(v)} credits` : `after ${fmt(v)} of credit notes`;
}
