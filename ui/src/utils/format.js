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

// Report cells: a dash for zero (matching Xero's own reports, where 0 and "no
// activity" look the same) and parentheses for negatives.
export function fmtCell(n) {
  const v = Number(n || 0);
  if (v === 0) return '-';
  const abs = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `(${abs})` : abs;
}
