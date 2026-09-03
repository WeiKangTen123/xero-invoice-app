// ── Currency ────────────────────────────────────────────────────────────────
// Xero returns invoice, quote, payment and bank-transaction amounts in the
// DOCUMENT's own currency, while every report endpoint (P&L, Budget Summary,
// Bank Summary) returns the organisation's BASE currency. Summing the two
// without converting silently adds USD to SGD and reports the result as though
// it meant something.
//
// currencyRate is the rate Xero stamped on the document when it was raised, so
// converting with it reproduces exactly what Xero's own reports show. It is set
// only on non-base-currency documents. Payments carry a rate but no code — for
// those the rate alone decides.
function _toBase(doc, amount, baseCurrency = '') {
  const v = Number(amount || 0);
  if (!v || !doc) return v;
  const code = doc.currencyCode ? String(doc.currencyCode) : '';
  if (code && baseCurrency && code === baseCurrency) return v;   // already base
  const rate = Number(doc.currencyRate || 0);
  if (rate > 0 && rate !== 1) return v * rate;
  return v;
}

// Which foreign currencies are present, and how many documents we could NOT
// convert. A single-currency org gets { mixed: false } and nothing changes; a
// multi-currency one gets a figure it can trust plus an honest note about any
// document Xero gave us no rate for.
function _foreignCurrency(docs = [], baseCurrency = '') {
  const currencies = new Set();
  let unconvertible = 0;
  for (const d of docs || []) {
    const code = d && d.currencyCode ? String(d.currencyCode) : '';
    if (!code || (baseCurrency && code === baseCurrency)) continue;
    currencies.add(code);
    if (!(Number(d.currencyRate) > 0)) unconvertible++;
  }
  return {
    currencies: [...currencies].sort(),
    mixed: currencies.size > 0,
    unconvertible,
    baseCurrency: baseCurrency || null,
  };
}

module.exports = { _toBase, _foreignCurrency };
