// Money/percentage formatting shared by the dashboard panels. Extracted so the
// Overview and Revenue panels format identically to the tabs that predate them —
// two copies of "how we render a negative" is how reports start disagreeing.

export function fmtMoney(n, currency) {
  const v = Number(n || 0);
  return `${currency ? currency + ' ' : ''}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Compact form for chart labels and tiles, where two decimals are noise.
export function fmtMoneyShort(n, currency) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  const unit = abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const num = (v / unit[0]).toFixed(abs >= 1e3 && abs / unit[0] < 100 ? 1 : 0).replace(/\.0$/, '');
  return `${currency ? currency + ' ' : ''}${num}${unit[1]}`;
}

// Takes a FRACTION (0.16), not a percentage.
export function fmtPct(fraction, dp = 1) { return `${(Number(fraction || 0) * 100).toFixed(dp)}%`; }

// True for an amount that prints as 0.00. A sum of floats can land a hair off
// zero, and that should read as nil rather than as "0.00" or "(0.00)".
export function isNilAmount(n) {
  return Math.round(Number(n || 0) * 100) === 0;
}

// Report cells: a dash for zero (matching Xero's own reports, where 0 and "no
// activity" look the same) and parentheses for negatives.
//
// The number locale is fixed rather than taken from the browser. These cells
// are the budget reports, whose PDF and Excel exports print 1,234.56; a German
// browser showing 1.234,56 beside the printed copy makes the two look like
// different figures.
export function fmtCell(n) {
  const v = Number(n || 0);
  if (isNilAmount(v)) return '-';
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${abs})` : abs;
}

// Xero's Budget Variance percentage: two decimals and no plus sign (195.20%,
// -11.46%). A line on budget, or with no budget to divide by, prints a dash in
// Xero rather than 0.00%, so it does here. Takes the FRACTION the server sends.
export function fmtVariancePct(variance, fraction) {
  if (isNilAmount(variance) || fraction === null || fraction === undefined) return '-';
  const s = (Number(fraction) * 100).toFixed(2);
  return `${s === '-0.00' ? '0.00' : s}%`;
}
