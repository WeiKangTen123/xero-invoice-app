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

const PASS = '\x1b[32m✓\x1b[0m', FAIL = '\x1b[31m✗\x1b[0m', SKIP = '\x1b[33m⊘\x1b[0m';
let failures = 0, skipped = 0;

// Scopes granted at consent time. A token can be perfectly valid and still be
// unable to reach an endpoint, which is a stale CONNECTION, not a broken build —
// reporting it as a failure would make the smoke test cry wolf.
function scopesOf(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return Array.isArray(claims.scope) ? claims.scope : String(claims.scope || '').split(' ');
  } catch { return []; }
}
const REQUIRED = ['accounting.reports.budgetsummary.read', 'accounting.payments.read'];

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
    let detail = err?.message, status = null, wwwAuth = '';
    if (typeof err === 'string') {
      try {
        const p = JSON.parse(err);
        status  = p.response?.statusCode;
        wwwAuth = p.response?.headers?.['www-authenticate'] || '';
        detail  = `${status} ${JSON.stringify(p.response?.body).slice(0, 110)}`;
      } catch { detail = err.slice(0, 160); }
    }
    // Xero signals a missing scope with 401 + insufficient_scope, or a 403.
    const isScope = status === 403 || (status === 401 && /insufficient_scope/i.test(wwwAuth))
                 || (status === 401 && /AuthorizationUnsuccessful/i.test(detail));
    if (isScope) { skipped++; console.log(`  ${SKIP} ${name.padEnd(34)} needs a reconnect — scope not granted on this token`); }
    else         { failures++; console.log(`  ${FAIL} ${name.padEnd(34)} ${detail}`); }
  }
}

(async () => {
  const argUser = process.argv[2];
  const conns = db.prepare('SELECT user_id, tenant_id, tenant_name FROM xero_tenants').all()
    .filter(c => !argUser || c.user_id === argUser);
  if (!conns.length) { console.error('No connected Xero organisation found.'); process.exit(1); }

  // Prefer a connection whose token still works — a stale one would fail every
  // check for a reason that has nothing to do with the code under test.
  // Prefer a connection that holds every scope the checks need — otherwise the
  // run reports a stale token as six broken endpoints.
  let conn = null, fallback = null, missingScopes = [];
  for (const c of conns) {
    let token;
    try { token = await tokenCache.forUser(c.user_id).getValidToken(c.tenant_id); }
    catch { continue; }
    const have = scopesOf(token);
    const missing = REQUIRED.filter(x => !have.includes(x));
    if (!missing.length) { conn = c; break; }
    if (!fallback) { fallback = c; missingScopes = missing; }
  }
  if (!conn && fallback) {
    conn = fallback;
    console.log(`\n\x1b[33mNote:\x1b[0m no fully-scoped connection found; using ${fallback.user_id},`);
    console.log(`      which is missing: ${missingScopes.join(', ')}`);
    console.log('      Those endpoints will be reported as skipped, not failed.');
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

  const skipNote = skipped ? ` (${skipped} skipped — scope not granted)` : '';
  console.log(failures === 0
    ? `\n\x1b[32mAll checks passed\x1b[0m${skipNote} — every endpoint accepted by Xero.\n`
    : `\n\x1b[31m${failures} check(s) failed\x1b[0m${skipNote}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('Smoke test crashed:', err?.message || err); process.exit(1); });
