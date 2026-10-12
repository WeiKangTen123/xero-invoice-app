const logger = require('../utils/logger');
const { _dedupe } = require('./report-cache');
const { getCashManager, _todayBalanceWindow } = require('./cash-manager');
const { getAgeing } = require('./ageing');
const { getBankSummary } = require('./bank');
const { _cents, _norm } = require('./budget-variance');
const { _compareLines } = require('./balance-check');
const { _parseISODate } = require('./periods');

// Check against Xero: proof that the Cash Flow Manager starts from what Xero
// holds. The same shape as the Budget and Balance Sheet checks, three checks:
//
//   1. balance — each bank account counted in the opening balance against the
//      closing balance Xero's Bank Summary gives it today, and their total;
//   2. receivables and 3. payables — every open invoice (bill) the projection
//      read, before credit notes and before any change made here, against the
//      ageing's total for the same side, which is the Dashboard's headline
//      Total Receivables (Payables) by another road.
//
// All three read what the projection has just read, from the cache, so the
// check costs no Xero call of its own when the tab is on screen. What they
// prove is that no account was mismatched or counted twice and no open
// invoice was lost or doubled on the way to a date. They do not check the
// dates themselves: those are a forecast, and Xero holds no figure to set
// them against.
//
// Not cached: it is built from cached reads, and the accounts counted are
// options a person can change between two looks.

const _skip = (key, label, reason) => ({ key, label, skipped: true, reason, calls: 0 });

const BALANCE_LABEL = 'bank balances against the Bank Summary';
async function _balanceCheck(userId, tenantId, cm, { timezone, force }) {
  if (!cm.bank.available) return _skip('balance', BALANCE_LABEL, 'Bank balances could not be read from Xero, so there is nothing to check them against.');
  const counted = cm.bank.accounts.filter(a => a.included && !a.foreign);
  if (!counted.length) return _skip('balance', BALANCE_LABEL, 'No bank account is counted in the opening balance, so there is no balance to check.');

  const summary = await getBankSummary(userId, tenantId, { ..._todayBalanceWindow(_parseISODate(cm.today)), force });
  const byName  = new Map((summary.accounts || []).map(a => [_norm(a.name), a]));
  const column  = { label: `Closing ${cm.today}` };
  const lines = [], onlyInApp = [];
  let xeroTotal = 0, appTotal = 0;
  for (const a of counted) {
    const line = byName.get(_norm(a.name));
    if (!line) { onlyInApp.push(a.name); continue; }
    lines.push({ label: a.name, app: [a.balance], xero: [line.closingBalance] });
    xeroTotal += line.closingBalance;
    appTotal  += a.balance;
  }
  // The total the projection starts from, less the adjustments made here,
  // which are the person's own and not Xero's.
  const adjustments = counted.reduce((s, a) => s + Number(a.openingAdjustment || 0), 0);
  lines.push({ label: 'Opening balance, less adjustments made here', app: [_cents(cm.bank.balance - adjustments)], xero: [_cents(xeroTotal)] });
  const listed = new Set(cm.bank.accounts.map(a => _norm(a.name)));
  const onlyInXero = (summary.accounts || []).filter(a => !listed.has(_norm(a.name)) && Math.abs(a.closingBalance) >= 0.01).map(a => a.name);
  const left = cm.bank.accounts.filter(a => !a.included || a.foreign);
  const cmp = _compareLines(lines, [column]);
  return {
    key: 'balance', label: BALANCE_LABEL, skipped: false,
    ok: cmp.differences.length === 0 && onlyInXero.length === 0 && onlyInApp.length === 0,
    ...cmp, onlyInXero, onlyInApp, calls: summary.cached === false ? 1 : 0,
    proves: `Each of the ${counted.length} bank account${counted.length === 1 ? '' : 's'} counted in the opening balance `
      + `against the closing balance Xero's Bank Summary gives it on ${cm.today}, and their total (${_cents(appTotal).toFixed(2)}) `
      + `against the opening balance less any adjustment made here.`
      + (left.length ? ` Left out, as on the tab: ${left.map(a => `${a.name}${a.foreign ? ` (${a.currency})` : ' (switched off here)'}`).join(', ')}.` : '')
      + ' Agreement means the projection starts from the balances Xero holds today, each account counted once.',
  };
}

const SIDES = {
  receivables: { label: 'receivables against the ageing', docs: 'sales invoices', headline: 'Total Receivables' },
  payables:    { label: 'payables against the ageing',    docs: 'bills',          headline: 'Total Payables' },
};
async function _openCheck(userId, tenantId, cm, side, { timezone, force }) {
  const spec = SIDES[side];
  // The same day's ageing, from the same cached reads the projection used.
  const ageing = await getAgeing(userId, tenantId, { side, timezone, force });
  const mine = cm.open[side];
  const column = { label: cm.today };
  const lines = [
    { label: `Open ${spec.docs}, amount`, app: [mine.amount], xero: [ageing.gross] },
    { label: `Open ${spec.docs}, count`,  app: [mine.count],  xero: [ageing.count] },
  ];
  const cmp = _compareLines(lines, [column]);
  return {
    key: side, label: spec.label, skipped: false, ok: cmp.differences.length === 0,
    ...cmp, onlyInXero: [], onlyInApp: [], calls: ageing.cached === false ? 1 : 0,
    proves: `Every approved ${spec.docs.replace(/s$/, '')} with an amount due that the projection read (${mine.count}, `
      + `${_cents(mine.amount).toFixed(2)} before credit notes and changes made here, past the ${cm.horizonDays} days too) `
      + `against the ageing's total before credit notes, which is the Dashboard's ${spec.headline}. Agreement means no open `
      + `${spec.docs.replace(/s$/, '')} was lost or counted twice on the way to a date.`,
  };
}

async function _getCashManagerCheckRaw(userId, tenantId, { timezone = 'UTC', force = false } = {}) {
  // The tab under check, through its own in-flight sharing and cached reads.
  const cm = await getCashManager(userId, tenantId, { timezone, force });
  const opts = { timezone, force: false };
  // A rejection is the caller's answer: a failure to reach Xero is a failure,
  // never an "agrees".
  const checks = [
    await _balanceCheck(userId, tenantId, cm, opts),
    await _openCheck(userId, tenantId, cm, 'receivables', opts),
    await _openCheck(userId, tenantId, cm, 'payables', opts),
  ];
  const ran = checks.filter(c => !c.skipped);
  const ok  = ran.length > 0 && ran.every(c => c.ok);
  const notes = [
    ...checks.map(c => (c.skipped ? c.reason : c.proves)),
    'The dates items are placed on are a forecast and are not checked: Xero holds no figure to set them against. '
      + 'Entries and changes made here are this app\'s own and are left out of every comparison.',
  ];
  logger.info('Cash manager check against Xero', {
    userId, tenantId, today: cm.today, calls: checks.reduce((s, c) => s + (c.calls || 0), 0), ok,
    differences: ran.reduce((s, c) => s + c.differences.length + c.onlyInXero.length + c.onlyInApp.length, 0),
  });
  return {
    ok,
    checkedAt: new Date().toISOString(),
    calls:     checks.reduce((s, c) => s + (c.calls || 0), 0),
    checks,
    notes,
    currency:  cm.organisation?.currency || '',
    period:    null,
  };
}

// Bound through the one in-flight map in ./report-cache, so two clicks in
// flight are one check.
const getCashManagerCheck = _dedupe('getCashManagerCheck', _getCashManagerCheckRaw, { timezone: 'UTC', force: false });

module.exports = { getCashManagerCheck, _balanceCheck, _openCheck };
