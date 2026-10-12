// The performance report on the screen side: which of its costly extras a
// request asks for, when a report already on screen must be asked for again
// to get one, and when the AI commentary counts as analysed.
//
// One report feeds Overview, Revenue, Banking, Profitability and Analysis, and
// a tab reached from another reuses the report that tab asked for. Two of its
// parts are asked for only by the tab that shows them — the top customers and
// quotes (Revenue: an invoice and a quote read) and the period's cash in and
// out (Banking: a bank summary over the whole year) — so a report loaded on
// Overview carried neither, and the Revenue tab hid its cards while Banking
// showed the last 31 days under the financial year's label.
//
// Plain functions with no imports, so main/scripts/dashboard-cards-ui.test.js
// can load and run them; the page (XeroInsights.jsx) only wires them in.

// Whether a report answered for the top customers: read them, or tried and
// could not. One that never asked says so (reason 'not-asked'); a server from
// before that said nothing, and is taken as not having asked.
export function hasCustomers(d) {
  const c = d?.customerRevenue;
  return !!c && (c.available === true || c.reason === 'failed');
}

// Whether a report's cash in and out cover the period rather than the last 31
// days, which is all the Overview asks for (it shows only the balance).
export function hasPeriodCashFlow(d) {
  return d?.cash?.flowScope === 'period';
}

// What a request for the figures asks for besides them. The open tab asks for
// what it shows. A re-ask of the figures already on screen (`onScreen`) — for
// last year's months, or after a change seen in Xero — also keeps what they
// carried, or the Revenue tab's cards and Banking's cash flow would be
// dropped from under the next visit to either. A new period or organisation
// passes no `onScreen`, so it pays only for the open tab's.
export function perfExtras(tab, onScreen = null) {
  return {
    cashFlow:  tab === 'banking' || hasPeriodCashFlow(onScreen),
    customers: tab === 'revenue' || hasCustomers(onScreen),
  };
}

// The report on screen is settled and is this tab's to show: loaded, not
// failed, and not the reply to a request that already asked for the part
// missing from it (`askedReply`), so a reply that somehow comes back without
// it cannot set off a loop of requests.
function settled(perf, askedReply) {
  const d = perf?.data;
  return !!d && perf.status === 'done' && !perf.error && d !== askedReply;
}

// The Revenue tab is open on a report that never asked for the top customers
// and quotes: ask again, with them. This year's figures come back from the
// server's cache; only the invoices and quotes are new.
export function shouldReaskCustomers(tab, perf, askedReply) {
  return tab === 'revenue' && settled(perf, askedReply) && !hasCustomers(perf.data);
}

// The Banking tab is open on a report whose cash in and out are the last 31
// days, not the period: ask again for the period's.
export function shouldReaskCashFlow(tab, perf, askedReply) {
  return tab === 'banking' && settled(perf, askedReply) && !hasPeriodCashFlow(perf.data);
}

// When the commentary was last analysed, from how its variance insights came
// back (a Promise.allSettled outcome): `now` when the model answered, null
// otherwise. A request that failed, or a reply that is the computed fallback
// (`failed` says why), is not an analysis, and "Analysis up to date" over it
// claimed one.
export function analysedAt(outcome, now) {
  const ok = outcome?.status === 'fulfilled' && !!outcome.value && !outcome.value.failed;
  return ok ? now : null;
}
