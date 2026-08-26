#!/usr/bin/env node
// READ-ONLY smoke test against a real Xero connection.
//
// The unit suite mocks Xero, so it proves our logic but never proves Xero will
// ACCEPT what we send. Two bugs shipped with a green suite for that reason: a
// 400 on getInvoices (DueDate ordering with summaryOnly) and a ReferenceError in
// getBudgetVariance's own wiring, which no test exercised because it needs a
// live token. This closes that gap.
//
// Every call is a GET. Nothing here writes to Xero, and no secret is printed.
//
//   node main/scripts/smoke-xero.js              # first connected user/org
//   node main/scripts/smoke-xero.js <userId>     # a specific account
//
// Exits non-zero if any check fails, so it can gate a deploy.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const db         = require('../db');
const tokenCache = require('../utils/token-cache');
const reports    = require('../xero/reports');

const PASS = '\x1b[32m✓\x1b[0m', FAIL = '\x1b[31m✗\x1b[0m';
let failures = 0;

async function check(name, fn, validate) {
  const started = Date.now();
  try {
    const result = await fn();
    const problem = validate ? validate(result) : null;
    const ms = Date.now() - started;
    if (problem) { failures++; console.log(`  ${FAIL} ${name.padEnd(34)} ${problem}`); }
    else         { console.log(`  ${PASS} ${name.padEnd(34)} ${String(ms).padStart(5)}ms`); }
  } catch (err) {
    failures++;
    // xero-node throws a raw JSON string rather than an Error, so the useful
    // detail is inside it — surface that, not "undefined".
    let detail = err?.message;
    if (typeof err === 'string') {
      try { const p = JSON.parse(err); detail = `${p.response?.statusCode} ${JSON.stringify(p.response?.body).slice(0, 120)}`; }
      catch { detail = err.slice(0, 160); }
    }
    console.log(`  ${FAIL} ${name.padEnd(34)} ${detail}`);
  }
}

(async () => {
  const argUser = process.argv[2];
  const conns = db.prepare('SELECT user_id, tenant_id, tenant_name FROM xero_tenants').all()
    .filter(c => !argUser || c.user_id === argUser);
  if (!conns.length) { console.error('No connected Xero organisation found.'); process.exit(1); }

  // Prefer a connection whose token still works — a stale one would fail every
  // check for a reason that has nothing to do with the code under test.
  let conn = null;
  for (const c of conns) {
    try { await tokenCache.forUser(c.user_id).getValidToken(c.tenant_id); conn = c; break; }
    catch { /* try the next */ }
  }
  if (!conn) { console.error('No usable Xero token — reconnect first.'); process.exit(1); }

  const { user_id: U, tenant_id: T, tenant_name } = conn;
  const tz = require('../utils/users').getUserConfig(U)?.TIMEZONE || 'UTC';
  console.log(`\nXero smoke test — READ ONLY\n  org: ${tenant_name}\n  tz : ${tz}\n`);

  const nonEmpty = key => r => (r && r[key] && r[key].length) ? null : `no ${key} returned`;

  await check('organisation + summary',   () => reports.getSummary(U, T, { force: true }),
    r => r?.organisation?.name ? null : 'no organisation name');
  await check('chart of accounts',        () => reports.getAccounts(U, T, { force: true }), nonEmpty('accounts'));
  await check('contacts',                 () => reports.getContacts(U, T, { force: true }),
    r => Array.isArray(r?.contacts) ? null : 'contacts not an array');
  await check('bank accounts',            () => reports.getBankAccounts(U, T, { force: true }),
    r => Array.isArray(r?.bankAccounts) ? null : 'bankAccounts not an array');

  // The period shapes that exercise every argument combination Xero is fussy about.
  for (const [label, period] of [
    ['budget variance · 1 month',  { preset: 'this-month' }],
    ['budget variance · fiscal yr', { preset: 'fy' }],
    ['budget variance · 32 months', { from: '2024-01', to: '2026-08' }],
  ]) {
    await check(label, () => reports.getBudgetVariance(U, T, { timezone: tz, period, force: true }),
      r => r?.months?.length ? null : 'no months returned');
  }

  await check('performance overview',     () => reports.getPerformance(U, T, { timezone: tz, period: { preset: 'fy-ytd' }, force: true }),
    r => r?.totals?.revenue ? null : 'no totals.revenue');
  await check('performance + customers',  () => reports.getPerformance(U, T, { timezone: tz, period: { preset: 'fy-ytd' }, customers: true, force: true }),
    r => r?.customerRevenue?.available ? null : 'customerRevenue unavailable');
  await check('cash flow',                () => reports.getCashFlow(U, T, { timezone: tz, period: { preset: 'fy-ytd' }, force: true }),
    r => (r?.movement && r?.workingCapital && r?.forecast?.weeks?.length === 13) ? null : 'incomplete cash flow payload');
  await check('profit & loss',            () => reports.getProfitAndLoss(U, T, { from: '2026-04-01', to: '2026-08-31', force: true }),
    r => typeof r?.netProfit === 'number' ? null : 'no netProfit');

  console.log(failures === 0
    ? `\n\x1b[32mAll checks passed\x1b[0m — every endpoint accepted by Xero.\n`
    : `\n\x1b[31m${failures} check(s) failed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('Smoke test crashed:', err?.message || err); process.exit(1); });
