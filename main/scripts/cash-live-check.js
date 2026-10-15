#!/usr/bin/env node
// READ-ONLY diagnostic: what Xero actually sends for the assumptions the Cash
// Flow Manager (xero/cash-manager.js) and the Monthly forecast
// (xero/cash-monthly.js) make about it. The unit suite mocks Xero, so only live
// data can confirm these. Each question is answered YES / NO / UNKNOWN with the
// evidence (counts and a few example values), then a one-line summary each.
//
// Run it on the server, after the deploy that ships it (paths and user from
// main/scripts/deploy.sh: the app lives in /home/weika/xero-invoice-app and
// runs as weika). From your own machine, one line:
//
//   gcloud compute ssh xero-automation --zone=us-central1-a --project=steady-hallway-504812-d1 --account=wkang@flovon.ai --command='sudo -u weika -H bash -lc "cd /home/weika/xero-invoice-app && node main/scripts/cash-live-check.js --email <your app login email>"'
//
// or, already on the box:
//
//   sudo -u weika -H bash -lc 'cd /home/weika/xero-invoice-app && node main/scripts/cash-live-check.js --email <your app login email>'
//
// Add --tenant "<org name or tenant id>" when the account has more than one
// organisation connected (the first is used otherwise, and the others named).
//
// Towards Xero it only reads: every call goes through _readOnly below, which
// lets an AccountingApi method through only when its name starts with "get"
// and refuses anything else outright. The only writes are the ones the app
// itself makes whenever it connects, to its own database: getting a token
// refreshes it through the app's own path (as main/scripts/smoke-xero.js
// does), which saves the rotated refresh token and the connected-org list.
//
// Calls are made one at a time, at least a second apart (so never more than
// 60 a minute or 1 at once), about 20 in all, and never more than 40. No
// token, contact list or email other than the one given is printed.
'use strict';

const path = require('path');

const USAGE = `Usage: node main/scripts/cash-live-check.js --email <app login email> [--tenant "<org name or id>"]

Read-only check of what Xero sends for the Cash Flow Manager's assumptions.
Only GET calls are made to Xero (about 20, at most 40, one a second).

  --email   the app user whose Xero connection to use (required)
  --tenant  the organisation, by name or tenant id (default: the first connected)
  --help    this text`;

// The read guard. Only a method whose name starts with "get" reaches Xero.
const READ_RE  = /^get[A-Z]/;
// What the test asserts was never called.
const WRITE_RE = /^(create|update|delete|put|post|email|void)/i;
const DEFAULT_GAP_MS    = 1000;
const DEFAULT_MAX_CALLS = 40;
const RUN_TIMEOUT_MS    = 8 * 60 * 1000;
const SAMPLE_INVOICES   = 3;

// ── The app's own modules, loaded on first use so --help touches nothing ────
let _lib = null;
function L() {
  if (!_lib) {
    _lib = {
      bank:        require('../xero/bank'),
      budget:      require('../xero/budget-variance'),
      cashFlow:    require('../xero/cash-flow'),
      cashManager: require('../xero/cash-manager'),
      fetch:       require('../xero/report-fetch'),
      performance: require('../xero/performance'),
      periods:     require('../xero/periods'),
      utils:       require('../xero/xero-utils'),
    };
  }
  return _lib;
}

// ── Small helpers ────────────────────────────────────────────────────────────
const _norm  = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const _cents = v => Math.round(Number(v || 0) * 100);
const _m     = c => (c / 100).toFixed(2);                 // cents to "1234.56"
const _day   = v => L().performance._xeroDay(v);
const _has   = v => !!_day(v);
const _eq    = (a, b) => Math.abs(a - b) <= 1;            // within a cent
const _raw   = v => (v === undefined || v === null || v === '' ? '—' : `${_day(v) || '?'} [${String(v).slice(0, 32)}]`);
const _addDaysISO = (iso, n) => { const p = L().periods; return p._fmtISODate(p._addDays(p._parseISODate(iso), n)); };
const _xd    = iso => L().periods._fmtXeroDate(L().periods._parseISODate(iso));
const _plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

function _headerCells(rows) {
  return ((rows || []).find(r => r?.rowType === 'Header')?.cells || []).map(c => c?.value ?? '');
}

// Every plain Row of a report, at any depth.
function _plainRows(rows) {
  const out = [];
  (function walk(list) {
    for (const r of list || []) {
      if (r?.rowType === 'Row') out.push(r);
      if (r?.rows?.length) walk(r.rows);
    }
  })(rows);
  return out;
}

function _errInfo(err) {
  const u = L().utils;
  let status = 0, msg;
  try { status = u._parseXeroErr(err).status || 0; } catch (_) { /* not a Xero error */ }
  try { msg = u.xeroErrMsg(err); } catch (_) { msg = err?.message || String(err); }
  let scope = false;
  try { scope = u.isScopeError(err); } catch (_) { /* as above */ }
  msg = String(msg || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
  return { status, msg: `${status ? `HTTP ${status}: ` : ''}${msg}${scope ? ' (scope not granted on this connection)' : ''}` };
}

// ── Arguments ────────────────────────────────────────────────────────────────
function parseArgs(argv = []) {
  const out = { email: null, tenant: null, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    const eq = /^--(email|tenant)=(.*)$/.exec(a);
    if (eq) { out[eq[1]] = eq[2]; continue; }
    if (a === '--email' || a === '--tenant') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out.errors.push(`${a} needs a value`);
      else { out[a.slice(2)] = v; i++; }
      continue;
    }
    out.errors.push(`unknown argument: ${a}`);
  }
  if (!out.help) {
    if (!out.email) out.errors.push('--email is required');
    else if (!/^[^\s@]+@[^\s@]+$/.test(out.email)) out.errors.push('--email does not look like an email address');
  }
  return out;
}

// The organisation to read: by tenant id, then by name exactly, then by a name
// containing what was given when only one does. Without --tenant, the first.
function _pickTenant(tenants = [], wanted = null) {
  if (!tenants.length) return { error: 'no Xero organisation is connected for this user' };
  const names = tenants.map(t => t.tenantName || t.tenantId);
  if (!wanted) return { tenant: tenants[0], others: names.slice(1) };
  const w = _norm(wanted);
  const hit = tenants.find(t => t.tenantId === wanted)
    || tenants.find(t => _norm(t.tenantName) === w)
    || (tenants.filter(t => _norm(t.tenantName).includes(w)).length === 1 ? tenants.find(t => _norm(t.tenantName).includes(w)) : null);
  if (!hit) return { error: `no connected organisation matches "${wanted}" (connected: ${names.join(', ')})` };
  return { tenant: hit, others: [] };
}

// The scopes on a token, read from its claims; nothing else of it is used.
function _scopesOf(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString());
    return (Array.isArray(claims.scope) ? claims.scope : String(claims.scope || '').split(' ')).filter(Boolean);
  } catch (_) { return []; }
}

// ── The read guard ───────────────────────────────────────────────────────────
// Wraps an AccountingApi. A get* method is let through one at a time, at least
// `gapMs` after the previous call ended, and counted; any other method throws
// before it reaches the SDK. Past `maxCalls` nothing more is sent.
function _readOnly(api, { gapMs = DEFAULT_GAP_MS, maxCalls = DEFAULT_MAX_CALLS, stats = { calls: 0, byMethod: {} },
  sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last = 0;
  let chain = Promise.resolve();
  return new Proxy(api, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      if (!READ_RE.test(prop)) {
        return () => { throw new Error(`refused: AccountingApi.${prop} is not a read — this script only calls get* methods`); };
      }
      return (...args) => {
        const run = async () => {
          if (stats.calls >= maxCalls) throw new Error(`call budget of ${maxCalls} reached — ${prop} not sent`);
          const wait = last + gapMs - Date.now();
          if (wait > 0) await sleep(wait);
          stats.calls++;
          stats.byMethod[prop] = (stats.byMethod[prop] || 0) + 1;
          try { return await value.apply(target, args); } finally { last = Date.now(); }
        };
        // One at a time, whatever the caller does.
        const p = chain.then(run, run);
        chain = p.catch(() => {});
        return p;
      };
    },
    set() { throw new Error('refused: the read-only api cannot be changed'); },
  });
}

// ── Q1: the invoice list's payment dates ─────────────────────────────────────
const PAYMENT_DATE_FIELDS = [
  { key: 'expectedPaymentDate', label: 'ExpectedPaymentDate', short: 'Expected',  pool: 'open sales invoices',
    match: i => i?.type === 'ACCREC' && i?.status === 'AUTHORISED' },
  { key: 'plannedPaymentDate',  label: 'PlannedPaymentDate',  short: 'Planned',   pool: 'open bills',
    match: i => i?.type === 'ACCPAY' && i?.status === 'AUTHORISED' },
  { key: 'fullyPaidOnDate',     label: 'FullyPaidOnDate',     short: 'FullyPaid', pool: 'paid invoices and bills',
    match: i => i?.status === 'PAID' },
];

// Pure. Up to `n` open invoices to read one by one: those the list already
// shows a payment date on first, a sale and a bill where there are both.
function _pickOpenSample(invoices = [], n = SAMPLE_INVOICES) {
  const seen = new Set();
  const open = (invoices || []).filter(i => i?.invoiceID && i.status === 'AUTHORISED' && (i.type === 'ACCREC' || i.type === 'ACCPAY')
    && Number(i.amountDue) > 0 && !seen.has(i.invoiceID) && seen.add(i.invoiceID));
  const dated = i => _has(i.expectedPaymentDate) || _has(i.plannedPaymentDate);
  const pick = [];
  const add = i => { if (i && pick.length < n && !pick.includes(i)) pick.push(i); };
  add(open.find(i => dated(i) && i.type === 'ACCREC'));
  add(open.find(i => dated(i) && i.type === 'ACCPAY'));
  open.filter(dated).forEach(add);
  add(open.find(i => i.type === 'ACCREC'));
  add(open.find(i => i.type === 'ACCPAY'));
  open.forEach(add);
  return pick;
}

// Pure. `appList` is page 1 of the app's own read (AUTHORISED + PAID,
// summaryOnly, Date DESC: summary.js#_fetchSummaryRaw via _allInvoices),
// `openList` the same read of AUTHORISED only, `singles` invoices read one by
// one, `fullList` the same invoices listed without summaryOnly (read only when a
// single shows a date its list record lacked). `followUp` says which extra
// reads would settle what is still open.
function answerQ1({ appList = [], openList = [], singles = [], fullList = null } = {}) {
  const byId = new Map();
  for (const inv of [...(appList || []), ...(openList || [])]) if (inv?.invoiceID && !byId.has(inv.invoiceID)) byId.set(inv.invoiceID, inv);
  const listed = [...byId.values()];
  const fullById = new Map((fullList || []).map(i => [i?.invoiceID, i]));
  const reads = (singles || []).filter(Boolean);
  const lines = [
    `list (summaryOnly, as the app reads it): ${listed.length} invoices — ${listed.filter(i => i.status === 'AUTHORISED').length} open, ${listed.filter(i => i.status === 'PAID').length} paid; ${reads.length} read one by one`,
  ];
  const per = {};
  const missedIds = new Set();
  let needPaidSingle = false;
  for (const f of PAYMENT_DATE_FIELDS) {
    const pool = listed.filter(f.match);
    const inList = pool.filter(i => _has(i[f.key]));
    const singlePool = reads.filter(f.match);
    const onSingle = singlePool.filter(i => _has(i[f.key]));
    const listRec = s => byId.get(s.invoiceID);
    const missedByList = onSingle.filter(s => listRec(s) && !_has(listRec(s)[f.key]));
    const missedBySingle = singlePool.filter(s => !_has(s[f.key]) && listRec(s) && _has(listRec(s)[f.key]));
    const list = inList.length ? 'YES' : (missedByList.length ? 'NO' : 'UNKNOWN');
    const single = onSingle.length ? 'YES' : (missedBySingle.length ? 'NO' : 'UNKNOWN');
    per[f.short] = { list, single };
    missedByList.forEach(s => missedIds.add(s.invoiceID));
    if (f.key === 'fullyPaidOnDate' && pool.length && !inList.length && !singlePool.length) needPaidSingle = true;
    lines.push(`${f.label}: in list ${list} (${inList.length}/${pool.length} ${f.pool}); on single invoice ${single} (${onSingle.length}/${singlePool.length} read)`);
    if (fullList && missedByList.length) {
      const fullHas = missedByList.filter(s => _has(fullById.get(s.invoiceID)?.[f.key])).length;
      lines.push(`  the list WITHOUT summaryOnly carries it on ${fullHas}/${missedByList.length} of those`);
    }
    const shown = new Set();
    for (const s of [...missedByList, ...missedBySingle, ...onSingle]) {
      if (shown.size >= 3 || shown.has(s.invoiceID)) continue;
      shown.add(s.invoiceID);
      lines.push(`  e.g. ${s.invoiceNumber || s.invoiceID} ${s.type}: list ${_raw(listRec(s)?.[f.key])}, single ${_raw(s[f.key])}`);
    }
    for (const i of inList) {
      if (shown.size >= 3 || shown.has(i.invoiceID)) continue;
      shown.add(i.invoiceID);
      lines.push(`  e.g. ${i.invoiceNumber || i.invoiceID} ${i.type}: list ${_raw(i[f.key])}`);
    }
  }
  if (per.Expected.list === 'UNKNOWN' && per.Planned.list === 'UNKNOWN') {
    lines.push('no sampled open invoice or bill has an expected/planned payment date set — set one on an open invoice in Xero and run again to settle it');
  }
  const answers = Object.values(per).map(p => p.list);
  const answer = answers.includes('NO') ? 'NO' : (answers.includes('YES') ? 'YES' : 'UNKNOWN');
  const evidence = `in list: ${PAYMENT_DATE_FIELDS.map(f => `${f.short} ${per[f.short].list}`).join(', ')}; on single: ${PAYMENT_DATE_FIELDS.map(f => `${f.short} ${per[f.short].single}`).join(', ')}`;
  return { answer, evidence, lines, followUp: { missedIds: [...missedIds], needPaidSingle } };
}

// ── Q2: AmountDue and payments dated after today ─────────────────────────────

// A payment's amount in the bank account's currency.
function _bankAmountCents(p) {
  if (p?.bankAmount !== undefined && p?.bankAmount !== null) return _cents(p.bankAmount);
  const rate = Number(p?.currencyRate);
  return _cents(rate > 0 && rate !== 1 ? Number(p?.amount || 0) / rate : p?.amount);
}

// Pure. `futurePayments`: AUTHORISED payments dated after `todayISO`.
// `invoices`: up to three of the invoices they pay, read one by one (with their
// Payments). YES means AmountDue has already been reduced by the future-dated
// payment, which is what cash-manager.js assumes.
function answerQ2({ todayISO, futurePayments = [], invoices = [], capped = false } = {}) {
  const { _isLive } = L().cashFlow;
  const future = (futurePayments || []).filter(p => p && _isLive(p) && (_day(p.date) || '') > todayISO);
  const byInv = new Map();
  for (const p of future) {
    const id = p.invoice?.invoiceID;
    if (!id) continue;
    const e = byInv.get(id) || { cents: 0, count: 0 };
    e.cents += _cents(p.amount); e.count++;
    byInv.set(id, e);
  }
  const lines = [`${_plural(future.length, 'AUTHORISED payment')} dated after ${todayISO}, ${byInv.size} on invoices${capped ? ' (read stopped at the page cap)' : ''}`];
  if (!byInv.size) {
    return { answer: 'UNKNOWN', evidence: `no AUTHORISED payment against an invoice is dated after ${todayISO} — nothing to compare`, lines };
  }
  const verdicts = [];
  let paidIncl = 0, paidExcl = 0;
  for (const inv of (invoices || []).filter(Boolean)) {
    const total = _cents(inv.total), paid = _cents(inv.amountPaid), credited = _cents(inv.amountCredited), due = _cents(inv.amountDue);
    const formula = total - paid - credited;
    const listed = byInv.get(inv.invoiceID)?.cents || 0;
    let verdict = 'unclear', payNote = 'Payments not returned on the invoice';
    if (Array.isArray(inv.payments)) {
      const live = inv.payments.filter(p => p && _isLive(p));
      const past = live.filter(p => (_day(p.date) || '') <= todayISO).reduce((s, p) => s + _cents(p.amount), 0);
      const onInvFuture = live.filter(p => (_day(p.date) || '') > todayISO).reduce((s, p) => s + _cents(p.amount), 0);
      // The payments list is the authority on what is dated after today; the
      // invoice's own Payments may or may not carry them.
      const fut = Math.max(onInvFuture, listed);
      const reduced = _eq(due, total - credited - past - fut);
      const notReduced = _eq(due, total - credited - past);
      verdict = reduced && !notReduced ? 'reduced' : (notReduced && !reduced ? 'not reduced' : 'unclear');
      if (_eq(paid, past + fut) && fut) paidIncl++;
      else if (_eq(paid, past) && fut) paidExcl++;
      payNote = `payments on the invoice: ${_m(past)} to date + ${_m(onInvFuture)} after today (payments list: ${_m(listed)} after today)`;
    }
    verdicts.push(verdict);
    lines.push(`${inv.invoiceNumber || inv.invoiceID} ${inv.type || ''} ${inv.status || ''}: AmountDue ${_m(due)}; Total ${_m(total)} − AmountPaid ${_m(paid)} − AmountCredited ${_m(credited)} = ${_m(formula)} (${_eq(formula, due) ? 'equals AmountDue' : 'differs'}); ${payNote} → ${verdict === 'reduced' ? 'AmountDue already net of the future payment' : verdict === 'not reduced' ? 'AmountDue still includes the future payment' : 'cannot tell'}`);
  }
  if (!verdicts.length) return { answer: 'UNKNOWN', evidence: `${byInv.size} invoice(s) with a future-dated payment, but none could be read`, lines };
  const all = v => verdicts.every(x => x === v);
  const answer = all('reduced') ? 'YES' : (all('not reduced') ? 'NO' : 'UNKNOWN');
  const counts = ['reduced', 'not reduced', 'unclear'].map(v => `${verdicts.filter(x => x === v).length} ${v}`).join(', ');
  const paidNote = paidIncl || paidExcl ? `; AmountPaid ${paidIncl ? 'includes' : 'excludes'} the future payment${paidIncl && paidExcl ? ' (mixed)' : ''}` : '';
  return {
    answer,
    evidence: `${verdicts.length} invoice(s) with a payment dated after today: ${counts}${paidNote} (YES = AmountDue is already net of it)`,
    lines,
  };
}

// ── Q3: Bank Summary names against the BANK accounts ────────────────────────

// Pure. `rows`: a Bank Summary's rows; `bankAccounts`: getAccounts(Type=="BANK").
function answerQ3({ rows = [], bankAccounts = [], window = null } = {}) {
  const sum = L().bank._buildBankSummary(rows || []);
  const lines = [];
  if (window) lines.push(`Bank Summary ${window.from} → ${window.to} (the window the Cash Flow Manager reads), columns: ${JSON.stringify(_headerCells(rows))}`);
  const listByNorm = new Map((bankAccounts || []).map(a => [_norm(a.name), a]));
  const sumByNorm = new Map(sum.accounts.map(a => [_norm(a.name), a]));
  const onlySummary = sum.accounts.filter(a => !listByNorm.has(_norm(a.name))).map(a => a.name);
  const onlyList = (bankAccounts || []).filter(a => !sumByNorm.has(_norm(a.name))).map(a => `${a.name} (${a.status || '?'})`);
  const caseOnly = sum.accounts.filter(a => { const l = listByNorm.get(_norm(a.name)); return l && l.name !== a.name; })
    .map(a => `"${a.name}" vs "${listByNorm.get(_norm(a.name)).name}"`);
  lines.push(`${_plural(sum.accounts.length, 'account line')} in the Bank Summary, ${_plural((bankAccounts || []).length, 'BANK account')} in the list`);
  lines.push(`only in the Bank Summary: ${onlySummary.length ? onlySummary.join(', ') : 'none'}`);
  lines.push(`only in the accounts list: ${onlyList.length ? onlyList.join(', ') : 'none'}`);
  if (caseOnly.length) lines.push(`match only when case/spacing is ignored (as the app compares): ${caseOnly.join(', ')}`);

  const ids = new Set((bankAccounts || []).map(a => a.accountID).filter(Boolean));
  const attrIds = new Set();
  let withAttr = 0, idHits = 0;
  const raw = _plainRows(rows);
  for (const r of raw) {
    let any = false;
    for (const c of r.cells || []) {
      for (const at of c?.attributes || []) {
        any = true;
        attrIds.add(at?.id);
        if (ids.has(at?.value)) idHits++;
      }
    }
    if (any) withAttr++;
  }
  const attrNote = withAttr
    ? `${withAttr}/${raw.length} rows carry cell attributes (ids: ${[...attrIds].join(', ')}); ${idHits} attribute value(s) equal a BANK AccountID`
    : `no cell attributes on any of the ${raw.length} rows — no account IDs`;
  lines.push(`row attributes: ${attrNote}`);

  if (!sum.accounts.length) return { answer: 'UNKNOWN', evidence: `no account lines in the Bank Summary (columns ${JSON.stringify(_headerCells(rows))}); ${attrNote}`, lines };
  const answer = onlySummary.length ? 'NO' : 'YES';
  const evidence = `${sum.accounts.length} summary lines vs ${(bankAccounts || []).length} BANK accounts; only in summary: ${onlySummary.length ? onlySummary.join(', ') : 'none'}; only in list: ${onlyList.length ? onlyList.join(', ') : 'none'}; ${withAttr ? `IDs in attributes: ${idHits ? 'yes' : 'no'} (${[...attrIds].join(', ')})` : 'no IDs in cell attributes'}`;
  return { answer, evidence, lines };
}

// ── Q4: repeating invoice schedules ──────────────────────────────────────────

// Pure. `templates`: getRepeatingInvoices(Status=="AUTHORISED"), raw.
function answerQ4({ templates = [], todayISO, horizonISO = null } = {}) {
  const cm = L().cashManager;
  const raw = (templates || []).filter(Boolean);
  const rawById = new Map(raw.map(r => [r.repeatingInvoiceID || r.iD, r]));
  const list = cm._templatesOf(raw);
  const until = horizonISO || _addDaysISO(todayISO, cm.HORIZON_DAYS);
  const lines = [`${_plural(raw.length, 'template')} returned, ${list.length} AUTHORISED sales/bill templates`];
  if (!list.length) return { answer: 'UNKNOWN', evidence: 'no AUTHORISED repeating invoice templates', lines };

  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  lines.push(`${pad('#', 3)}${pad('id', 7)}${pad('type', 7)}${pad('total', 12)}${pad('every', 11)}${pad('start', 11)}${pad('next', 11)}${pad('end', 11)}${pad('due terms', 26)}${pad('next due', 11)}flags`);
  let past = 0, missing = 0, leftOut = 0, ended = 0;
  const units = {};
  list.forEach((t, k) => {
    const s = t.schedule;
    const flags = [];
    if (!s.nextScheduledDate) { flags.push('NO NEXT DATE'); missing++; } else if (s.nextScheduledDate < todayISO) { flags.push('NEXT BEFORE TODAY'); past++; }
    if (s.endDate && s.endDate < todayISO) { flags.push('ENDED'); ended++; }
    if (!['WEEKLY', 'MONTHLY'].includes(s.unit) || !s.nextScheduledDate) { flags.push('app leaves it out'); leftOut++; }
    units[s.unit || '?'] = (units[s.unit || '?'] || 0) + 1;
    const nextDue = s.nextScheduledDate ? cm._repeatingDue(s.nextScheduledDate, s) : '';
    const upcoming = cm._repeatingDates(s, until, 3);
    const id = String(t.repeatingInvoiceId || '').slice(-6);
    lines.push(`${pad(k + 1, 3)}${pad(id, 7)}${pad(t.type, 7)}${pad(`${t.total.toFixed(2)} ${t.currencyCode}`.trim(), 12)}${pad(`${s.period} ${s.unit || '?'}`, 11)}${pad(s.startDate || '—', 11)}${pad(s.nextScheduledDate || '—', 11)}${pad(s.endDate || '—', 11)}${pad(`${s.dueDate} ${s.dueDateType || '?'}`, 26)}${pad(nextDue || '—', 11)}${flags.join(', ')}${upcoming.length ? `  (raises ${upcoming.join(', ')})` : ''}`);
  });
  const sample = rawById.get(list[0].repeatingInvoiceId)?.schedule || {};
  const rawForm = `StartDate ${JSON.stringify(sample.startDate ?? null)}, NextScheduledDate ${JSON.stringify(sample.nextScheduledDate ?? null)}, EndDate ${JSON.stringify(sample.endDate ?? null)}`;
  lines.push(`as Xero sends them (template 1): ${rawForm}`);
  const answer = past || missing ? 'NO' : 'YES';
  const unitText = Object.entries(units).map(([u, n]) => `${n} ${u}`).join(', ');
  const evidence = `${list.length} AUTHORISED templates (${unitText}); ${past} with NextScheduledDate before today, ${missing} without one, ${ended} ended, ${leftOut} the app leaves out; raw form e.g. ${JSON.stringify(sample.nextScheduledDate ?? null)}`;
  return { answer, evidence, lines };
}

// ── Q5: accounts with no movement in the Bank Summary ───────────────────────

// Pure. `old`/`now`: { rows, window: { from, to, label }, error }.
// YES means an account with no movement is still listed (with zeros).
function answerQ5({ old = {}, now = {}, bankAccounts = [] } = {}) {
  const build = L().bank._buildBankSummary;
  const lines = [];
  let oldCase = 'error', oldDesc;
  const oldLabel = old.window ? `${old.window.from} → ${old.window.to}` : 'old month';
  if (old.error) {
    oldDesc = `call failed — ${old.error}`;
  } else {
    const s = build(old.rows || []);
    const zero = a => !_cents(a.cashReceived) && !_cents(a.cashSpent) && !_cents(a.openingBalance) && !_cents(a.closingBalance);
    if (!s.accounts.length) { oldCase = 'absent'; oldDesc = `no accounts listed (${_plainRows(old.rows).length} rows, columns ${JSON.stringify(_headerCells(old.rows))})`; }
    else if (s.accounts.every(zero)) { oldCase = 'zeros'; oldDesc = `${_plural(s.accounts.length, 'account')} listed, all zero`; }
    else { oldCase = 'values'; oldDesc = `${_plural(s.accounts.length, 'account')} listed with figures — the organisation already had transactions then, so this month says nothing`; }
  }
  lines.push(`before the first transaction (${oldLabel}): ${oldDesc}`);

  let zeroMove = [], absent = [], nowDesc;
  const nowLabel = now.window ? `${now.window.from} → ${now.window.to}` : 'this month';
  if (now.error) {
    nowDesc = `call failed — ${now.error}`;
  } else {
    const s = build(now.rows || []);
    const names = new Set(s.accounts.map(a => _norm(a.name)));
    zeroMove = s.accounts.filter(a => !_cents(a.cashReceived) && !_cents(a.cashSpent));
    absent = (bankAccounts || []).filter(a => String(a.status || 'ACTIVE').toUpperCase() === 'ACTIVE' && !names.has(_norm(a.name)));
    const withBal = zeroMove.filter(a => _cents(a.openingBalance) || _cents(a.closingBalance)).length;
    nowDesc = `${_plural(s.accounts.length, 'account')} listed; ${zeroMove.length} with no movement listed (${withBal} of them with a non-zero balance, ${zeroMove.length - withBal} all zero)`
      + `; ${_plural(absent.length, 'ACTIVE account')} not listed${absent.length ? `: ${absent.map(a => a.name).join(', ')}` : ''}`;
    for (const a of zeroMove.slice(0, 5)) lines.push(`  no movement, listed: ${a.name} opening ${a.openingBalance.toFixed(2)} closing ${a.closingBalance.toFixed(2)}`);
  }
  lines.splice(1, 0, `this month (${nowLabel}): ${nowDesc}`);

  const listedZeros = oldCase === 'zeros' || zeroMove.length > 0;
  const leftOut = oldCase === 'absent' || absent.length > 0;
  const answer = !listedZeros && !leftOut ? 'UNKNOWN' : (listedZeros && !leftOut ? 'YES' : 'NO');
  const evidence = `${oldLabel}: ${oldCase === 'absent' ? 'no accounts listed' : oldCase === 'zeros' ? 'listed with zeros' : oldCase === 'values' ? 'had figures' : 'failed'}; this month: ${zeroMove.length} listed with no movement, ${absent.length} ACTIVE not listed (YES = always listed with zeros)`;
  return { answer, evidence, lines };
}

// ── Q6 / Q9: the Budget Summary ──────────────────────────────────────────────

// Pure. What a Budget Summary holds, read the way budget-variance.js reads it.
function _budgetShape(rows = [], n = 12) {
  const lines = L().budget._reportLines(rows || [], { n });
  const sections = [];
  (function walk(list) {
    for (const r of list || []) {
      if (r?.rowType === 'Section') sections.push(r.title ?? '');
      if (r?.rows?.length) walk(r.rows);
    }
  })(rows);
  const nonZero = lines.filter(l => l.values.some(v => v !== 0));
  const kind = !lines.length ? 'none' : (!nonZero.length ? 'zeros' : 'values');
  const shape = kind === 'none' ? 'zero lines' : kind === 'zeros' ? `${lines.length} lines, all zero` : `${lines.length} lines, ${nonZero.length} with figures`;
  return { lines, sections, nonZero, kind, shape, header: _headerCells(rows), accounts: lines.filter(l => l.kind === 'account').length };
}

// Pure. `far`/`next`: { rows, window, error, status }. YES means the app reads
// a period with no budget as no budget: budget-variance.js's budgetMissing
// (_hasBudgetFigure, no account line with a figure in any chunk). The first
// live run (2026-10-15) found three summary lines at nought rather than
// nothing, which the earlier rule (no lines at all) took for a budget of nil.
function answerQ6({ far = {}, next = {} } = {}) {
  const lines = [];
  const sections = [];
  let farShape = null, nextShape = null;
  const farLabel = far.window ? `${far.window.label}` : 'far future';
  if (far.error) lines.push(`no-budget period (${farLabel}): Xero answered with an error — ${far.error}`);
  else {
    farShape = _budgetShape(far.rows, 12);
    lines.push(`no-budget period (${farLabel}): ${farShape.shape}; columns ${JSON.stringify(farShape.header)}`);
    for (const l of farShape.lines.slice(0, 5)) lines.push(`  line: [${l.section}] ${l.label} (${l.kind}) ${l.values.slice(0, 3).join(', ')}…`);
    farShape.sections.forEach(s => sections.push(s));
  }
  const nextLabel = next.window ? `${next.window.label}` : 'next 12 months';
  if (next.error) lines.push(`next 12 months (${nextLabel}): call failed — ${next.error}`);
  else {
    nextShape = _budgetShape(next.rows, 12);
    lines.push(`next 12 months (${nextLabel}): ${nextShape.shape} (${nextShape.accounts} account lines); columns ${JSON.stringify(nextShape.header)}`);
    lines.push(`  section titles exactly as sent: ${JSON.stringify(nextShape.sections)}`);
    nextShape.sections.forEach(s => sections.push(s));
  }
  let answer;
  if (far.error) answer = far.status === 400 ? 'NO' : 'UNKNOWN';
  else answer = !L().budget._hasBudgetFigure(farShape.lines) ? 'YES' : 'UNKNOWN';
  const farText = far.error ? `error (${far.error.slice(0, 80)})` : farShape.shape + (answer === 'UNKNOWN' ? ' — a budget exists that far ahead' : '');
  const nextText = next.error ? 'next 12 months failed' : `next 12 months: ${nextShape.lines.length} lines, sections ${JSON.stringify(nextShape.sections)}`;
  const uniq = [...new Set(sections.filter(s => String(s).trim()))];
  return { answer, evidence: `no-budget period: ${farText}; ${nextText} (YES = the app reads it as no budget)`, lines, sections: uniq };
}

const KIND_USE = {
  revenue:      'customer receipts',
  cogs:         'supplier payments',
  opex:         'wages / overheads',
  otherExpense: 'wages / overheads (non-cash and income tax left out)',
  otherIncome:  'left out of the forecast',
  other:        'NOTHING — its lines are dropped from the forecast',
};

// Pure. Every section title against budget-variance.js#_sectionKind.
function answerQ9({ sections = [] } = {}) {
  const { _sectionKind } = L().budget;
  const titles = [...new Set((sections || []).filter(s => String(s || '').trim()))];
  if (!titles.length) return { answer: 'UNKNOWN', evidence: 'no section titles to check (Q6 found none)', lines: [] };
  const lines = titles.map(t => { const k = _sectionKind(t); return `${JSON.stringify(t)} → ${k} → ${KIND_USE[k] || '?'}${k === 'other' ? '   <-- maps to nothing' : ''}`; });
  const unmapped = titles.filter(t => _sectionKind(t) === 'other');
  return {
    answer: unmapped.length ? 'NO' : 'YES',
    evidence: unmapped.length ? `maps to nothing: ${unmapped.map(t => JSON.stringify(t)).join(', ')}` : `all ${titles.length} titles map: ${titles.map(t => `${t}=${_sectionKind(t)}`).join(', ')}`,
    lines,
  };
}

// ── Q7: transfers and their two legs ─────────────────────────────────────────

// Pure. `transfers`: getBankTransfers; `legs`: getBankTransactions of the two
// transfer types over the same window.
function answerQ7({ transfers = [], legs = [], window = null, capped = false } = {}) {
  const { _isLive } = L().cashFlow;
  const list = (transfers || []).filter(t => t && _isLive(t));
  const legList = (legs || []).filter(t => t && _isLive(t) && /TRANSFER/i.test(t.type || ''));
  const byId = new Map(legList.map(t => [t.bankTransactionID, t]));
  const used = new Set();
  let viaId = 0;
  const take = (id, type, accountId, dayISO, amountCents) => {
    if (id && byId.has(id) && !used.has(id)) { used.add(id); viaId++; return byId.get(id); }
    const hit = legList.find(t => !used.has(t.bankTransactionID) && String(t.type || '').toUpperCase() === type
      && (!accountId || t.bankAccount?.accountID === accountId) && _day(t.date) === dayISO && _eq(_cents(t.total), amountCents));
    if (hit) { used.add(hit.bankTransactionID); return hit; }
    return null;
  };
  const missing = [];
  let found = 0, withIds = 0;
  for (const t of list) {
    const d = _day(t.date), amt = _cents(t.amount);
    if (t.fromBankTransactionID || t.toBankTransactionID) withIds++;
    const from = take(t.fromBankTransactionID, 'SPEND-TRANSFER', t.fromBankAccount?.accountID, d, amt);
    const to = take(t.toBankTransactionID, 'RECEIVE-TRANSFER', t.toBankAccount?.accountID, d, amt);
    found += (from ? 1 : 0) + (to ? 1 : 0);
    if (!from || !to) missing.push(`${d} ${_m(amt)}: ${!from && !to ? 'both legs' : !from ? 'spend leg' : 'receive leg'} missing`);
  }
  const orphans = legList.filter(t => !used.has(t.bankTransactionID));
  const lines = [
    `${window ? `${window.from} → ${window.to}: ` : ''}${_plural(list.length, 'transfer')} (${withIds} carry their leg IDs), ${_plural(legList.length, 'transfer leg')} among bank transactions${capped ? ' (read stopped at the page cap)' : ''}`,
    `legs found: ${found} of ${list.length * 2} (${viaId} by ID)`,
  ];
  for (const m of missing.slice(0, 10)) lines.push(`  ${m}`);
  if (orphans.length) lines.push(`legs with no transfer in the list: ${orphans.length} (e.g. ${orphans.slice(0, 3).map(t => `${_day(t.date)} ${t.type} ${_m(_cents(t.total))}`).join('; ')})`);
  if (!list.length) return { answer: 'UNKNOWN', evidence: 'no bank transfers in the last 6 months', lines };
  const answer = missing.length ? (capped ? 'UNKNOWN' : 'NO') : 'YES';
  return { answer, evidence: `${list.length} transfers, ${found}/${list.length * 2} legs found (${viaId} by ID), ${missing.length} with a leg missing, ${orphans.length} unmatched legs`, lines };
}

// ── Q8: does the Bank Summary count unreconciled entries? ───────────────────

// Pure. Last month's Bank Summary against that month's AUTHORISED payments and
// bank transactions per account, split by IsReconciled. YES means the Bank
// Summary's figures include unreconciled entries.
function answerQ8({ rows = [], payments = [], bankTransactions = [], bankAccounts = [], baseCurrency = '', window, capped = false } = {}) {
  const { _isLive, _isReceiptPayment } = L().cashFlow;
  const sum = L().bank._buildBankSummary(rows || []);
  const listByNorm = new Map((bankAccounts || []).map(a => [_norm(a.name), a]));
  const inWin = d => !!d && d >= window.from && d <= window.to;
  const recs = new Map();
  const add = (id, isIn, reconciled, c) => {
    const r = recs.get(id) || { inRec: 0, inUnrec: 0, outRec: 0, outUnrec: 0, n: 0, unrecN: 0 };
    r[`${isIn ? 'in' : 'out'}${reconciled ? 'Rec' : 'Unrec'}`] += c;
    r.n++; if (!reconciled) r.unrecN++;
    recs.set(id, r);
  };
  let pCount = 0, tCount = 0;
  for (const p of payments || []) {
    if (!p || !_isLive(p) || !inWin(_day(p.date)) || !p.account?.accountID) continue;
    pCount++;
    add(p.account.accountID, _isReceiptPayment(p), !!p.isReconciled, Math.abs(_bankAmountCents(p)));
  }
  for (const t of bankTransactions || []) {
    if (!t || !_isLive(t) || !inWin(_day(t.date)) || !t.bankAccount?.accountID) continue;
    tCount++;
    add(t.bankAccount.accountID, /^RECEIVE/i.test(t.type || ''), !!t.isReconciled, Math.abs(_cents(t.total)));
  }
  const lines = [`${window.from} → ${window.to}: ${_plural(sum.accounts.length, 'Bank Summary line')}; ${pCount} payments and ${tCount} bank transactions in the month${capped ? ' (a read stopped at the page cap)' : ''}`];
  const base = String(baseCurrency || '').toUpperCase();
  const verdicts = [];
  for (const a of sum.accounts) {
    const listed = listByNorm.get(_norm(a.name));
    if (!listed) { lines.push(`${a.name}: not in the BANK accounts list — skipped`); continue; }
    const cur = String(listed.currencyCode || '').toUpperCase();
    if (base && cur && cur !== base) { lines.push(`${a.name}: ${cur} account — skipped (only base-currency accounts are compared)`); continue; }
    const r = recs.get(listed.accountID) || { inRec: 0, inUnrec: 0, outRec: 0, outUnrec: 0, n: 0, unrecN: 0 };
    const sIn = _cents(a.cashReceived), sOut = _cents(a.cashSpent);
    const allIn = r.inRec + r.inUnrec, allOut = r.outRec + r.outUnrec;
    const allMatch = _eq(sIn, allIn) && _eq(sOut, allOut);
    const recMatch = _eq(sIn, r.inRec) && _eq(sOut, r.outRec);
    let v;
    if (!r.unrecN) v = allMatch ? 'none-match' : 'none-differs';
    else if (allMatch && !recMatch) v = 'all';
    else if (recMatch && !allMatch) v = 'reconciled';
    else v = 'neither';
    verdicts.push(v);
    const label = {
      'none-match': 'no unreconciled entries (matches; cannot tell)', 'none-differs': 'no unreconciled entries, and the totals differ',
      all: 'matches ALL entries (unreconciled counted)', reconciled: 'matches RECONCILED entries only', neither: 'matches neither total',
    }[v];
    lines.push(`${a.name}: Bank Summary in ${_m(sIn)} / out ${_m(sOut)}; all entries in ${_m(allIn)} / out ${_m(allOut)}; reconciled only in ${_m(r.inRec)} / out ${_m(r.outRec)}; ${r.unrecN} of ${r.n} unreconciled → ${label}`);
  }
  const nAll = verdicts.filter(v => v === 'all').length, nRec = verdicts.filter(v => v === 'reconciled').length;
  let answer = 'UNKNOWN';
  if (!capped) {
    if (nAll && !nRec) answer = 'YES';
    else if (nRec && !nAll) answer = 'NO';
  }
  const evidence = !verdicts.length
    ? 'no base-currency Bank Summary line could be matched to an account'
    : `${verdicts.length} accounts compared: ${nAll} match all entries, ${nRec} reconciled only, ${verdicts.filter(v => v === 'neither').length} neither, ${verdicts.filter(v => v.startsWith('none')).length} had no unreconciled entries${capped ? '; a read was capped' : ''} (YES = unreconciled counted)`;
  return { answer, evidence, lines };
}

// ── The run ──────────────────────────────────────────────────────────────────

// `deps`: findUser(email) → { id } | null; tenants(userId) → [{ tenantId,
// tenantName }]; token(userId, tenantId) → access token; timezone(userId);
// apiFor(token) → an AccountingApi. Everything Xero is reached through
// _readOnly. Returns { ok, results, calls }.
async function run({ email, tenant = null, deps, print = console.log, gapMs = DEFAULT_GAP_MS, maxCalls = DEFAULT_MAX_CALLS, todayISO = null } = {}) {
  const results = [];
  const stats = { calls: 0, byMethod: {} };
  print('Cash live check — READ ONLY towards Xero (GET calls only)');
  print(`  user  : ${email}`);

  const user = deps.findUser(email);
  if (!user) { print('No app user has that email address.'); return { ok: false, results, calls: 0 }; }
  const picked = _pickTenant(deps.tenants(user.id) || [], tenant);
  if (picked.error) { print(`Cannot choose an organisation: ${picked.error}`); return { ok: false, results, calls: 0 }; }
  const T = picked.tenant.tenantId;
  const tz = deps.timezone(user.id) || 'UTC';
  const P = L().periods, cm = L().cashManager;
  const today = todayISO ? P._parseISODate(todayISO) : P._todayPartsInTz(tz);
  const todayIso = P._fmtISODate(today);

  print(`  org   : ${picked.tenant.tenantName || '(unnamed)'} (tenant ${String(T).slice(0, 8)}…)${picked.others.length ? `   other connected orgs: ${picked.others.join(', ')} — pass --tenant to pick one` : ''}`);
  print(`  today : ${todayIso} (${tz})`);
  let api;
  try {
    const token = await deps.token(user.id, T);
    const scopes = _scopesOf(token).filter(s => s.startsWith('accounting.'));
    if (scopes.length) print(`  scopes: ${scopes.join(' ')}`);
    api = _readOnly(deps.apiFor(token), { gapMs, maxCalls, stats });
  } catch (err) {
    print(`Could not get a Xero token for this organisation: ${_errInfo(err).msg}`);
    return { ok: false, results, calls: stats.calls };
  }

  const one = fn => L().utils.withRetry(fn);
  const pages = async (fetchPage, field, maxPages, what) => {
    const list = await L().fetch._allPages(fetchPage, field, { what, tenantId: T, maxPages });
    return { list, capped: list.length >= L().fetch.LIST_PAGE_SIZE * maxPages };
  };
  const memo = new Map();
  const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  const invoice = id => once(`inv:${id}`, async () => (await one(() => api.getInvoice(T, id)))?.body?.invoices?.[0] || null);
  const bankAccounts = () => once('bankAccounts', async () => (await one(() => api.getAccounts(T, undefined, 'Type=="BANK"', 'Name ASC')))?.body?.accounts || []);
  const bankSummary = (from, to) => once(`bs:${from}:${to}`, async () => (await one(() => api.getReportBankSummary(T, from, to)))?.body?.reports?.[0]?.rows || []);
  const settle = async fn => { try { return { value: await fn() }; } catch (err) { return { error: _errInfo(err).msg, status: _errInfo(err).status }; } };

  // The organisation, for its base currency (Q8) and as a first proof the
  // connection works.
  let baseCurrency = '';
  const orgRead = await settle(async () => (await one(() => api.getOrganisations(T)))?.body?.organisations?.[0] || {});
  if (orgRead.value) {
    const o = orgRead.value;
    baseCurrency = o.baseCurrency ? String(o.baseCurrency) : '';
    print(`  base  : ${baseCurrency || '?'}; organisation created ${_day(o.createdDateUTC) || '?'}; year end ${o.financialYearEndDay || '?'}/${o.financialYearEndMonth || '?'}`);
  } else {
    print(`  organisation could not be read: ${orgRead.error}`);
  }

  async function ask(n, title, fn) {
    print(`\n── Q${n}. ${title}`);
    try {
      const r = await fn();
      for (const l of r.lines || []) print(`   ${l}`);
      print(`   => ${r.answer} — ${r.evidence}`);
      results.push({ n, answer: r.answer, evidence: r.evidence, data: r });
    } catch (err) {
      const { msg } = _errInfo(err);
      print(`   => UNKNOWN — call failed: ${msg}`);
      results.push({ n, answer: 'UNKNOWN', evidence: `call failed: ${msg}` });
    }
  }

  await ask(1, 'Does the invoice list carry ExpectedPaymentDate / PlannedPaymentDate / FullyPaidOnDate?', async () => {
    // Page 1 of exactly the app's read (report-fetch.js#_allInvoices from
    // summary.js), and the same of the open ones only.
    const appList = (await one(() => api.getInvoices(T, undefined, undefined, 'Date DESC', undefined, undefined, undefined,
      ['AUTHORISED', 'PAID'], 1, undefined, undefined, undefined, true)))?.body?.invoices || [];
    const openList = (await one(() => api.getInvoices(T, undefined, undefined, 'Date DESC', undefined, undefined, undefined,
      ['AUTHORISED'], 1, undefined, undefined, undefined, true)))?.body?.invoices || [];
    const singles = [];
    for (const inv of _pickOpenSample([...appList, ...openList], SAMPLE_INVOICES)) singles.push(await invoice(inv.invoiceID));
    let r = answerQ1({ appList, openList, singles });
    if (r.followUp.needPaidSingle) {
      const paid = appList.find(i => i?.status === 'PAID' && i.invoiceID);
      if (paid) singles.push(await invoice(paid.invoiceID));
      r = answerQ1({ appList, openList, singles });
    }
    let fullList = null;
    if (r.followUp.missedIds.length) {
      fullList = (await one(() => api.getInvoices(T, undefined, undefined, undefined, r.followUp.missedIds, undefined, undefined,
        undefined, 1, undefined, undefined, undefined, false)))?.body?.invoices || [];
    }
    return answerQ1({ appList, openList, singles, fullList });
  });

  await ask(2, 'Does AmountDue already leave out (net off) payments dated after today?', async () => {
    const from = _addDaysISO(todayIso, 1);
    const { list, capped } = await pages(page => api.getPayments(T, undefined, `Date >= ${_xd(from)} && Status=="AUTHORISED"`, 'Date ASC', page),
      'payments', 2, 'Payment');
    const ids = [];
    const invoicePayments = list.filter(p => /^ACC(REC|PAY)PAYMENT$/i.test(String(p?.paymentType || '')));
    for (const p of [...invoicePayments, ...list]) {
      const id = p?.invoice?.invoiceID;
      if (id && !ids.includes(id) && ids.length < SAMPLE_INVOICES) ids.push(id);
    }
    const invoices = [];
    for (const id of ids) invoices.push(await invoice(id));
    return answerQ2({ todayISO: todayIso, futurePayments: list, invoices, capped });
  });

  await ask(3, "Do the Bank Summary's account names match the BANK accounts list?", async () => {
    const win = cm._todayBalanceWindow(today);
    const rows = await bankSummary(win.from, win.to);
    return answerQ3({ rows, bankAccounts: await bankAccounts(), window: win });
  });

  await ask(4, 'Repeating invoices: StartDate / NextScheduledDate / EndDate', async () => {
    const res = await one(() => api.getRepeatingInvoices(T, 'Status=="AUTHORISED"'));
    return answerQ4({ templates: res?.body?.repeatingInvoices || [], todayISO: todayIso });
  });

  await ask(5, 'Bank Summary for a month before the first transaction, and for accounts with no movement', async () => {
    const oldM = P._monthMeta(today.year - 10, today.month);
    const oldWin = { from: oldM.startISO, to: oldM.endISO };
    const nowWin = { from: P._fmtISODate({ year: today.year, month: today.month, day: 1 }), to: todayIso };
    const oldRead = await settle(() => bankSummary(oldWin.from, oldWin.to));
    const nowRead = await settle(() => bankSummary(nowWin.from, nowWin.to));
    if (oldRead.error && nowRead.error) throw new Error(`both reads failed — ${nowRead.error}`);
    const accounts = await settle(bankAccounts);
    return answerQ5({
      old: { rows: oldRead.value, window: oldWin, error: oldRead.error },
      now: { rows: nowRead.value, window: nowWin, error: nowRead.error },
      bankAccounts: accounts.value || [],
    });
  });

  let q6 = null;
  await ask(6, 'Budget Summary for a period with no budget, and for the next 12 months', async () => {
    const farM = P._monthMeta(today.year + 3, today.month);
    const nextM = P._monthMeta(today.year, today.month + 1);
    const lastFar = P._monthMeta(today.year + 3, today.month + 11), lastNext = P._monthMeta(today.year, today.month + 12);
    // Anchored on the first month's last day, 12 periods, timeframe 1 — as
    // budget-variance.js asks.
    const farRead = await settle(async () => (await one(() => api.getReportBudgetSummary(T, farM.endISO, 12, 1)))?.body?.reports?.[0]?.rows || []);
    const nextRead = await settle(async () => (await one(() => api.getReportBudgetSummary(T, nextM.endISO, 12, 1)))?.body?.reports?.[0]?.rows || []);
    if (farRead.error && nextRead.error && farRead.status !== 400) throw new Error(`both reads failed — ${farRead.error}`);
    q6 = answerQ6({
      far:  { rows: farRead.value, error: farRead.error, status: farRead.status, window: { label: `${farM.label} – ${lastFar.label}, date=${farM.endISO}` } },
      next: { rows: nextRead.value, error: nextRead.error, status: nextRead.status, window: { label: `${nextM.label} – ${lastNext.label}, date=${nextM.endISO}` } },
    });
    return q6;
  });

  await ask(7, 'Do transfers come back as both legs?', async () => {
    const from = cm._monthDay(today.year, today.month - 6, today.day);
    const until = _addDaysISO(todayIso, 1);
    const win = { from, to: todayIso };
    const dates = `Date >= ${_xd(from)} && Date < ${_xd(until)}`;
    const transfers = (await one(() => api.getBankTransfers(T, undefined, dates, 'Date ASC')))?.body?.bankTransfers || [];
    let legs, capped = false;
    try {
      ({ list: legs, capped } = await pages(page => api.getBankTransactions(T, undefined,
        `${dates} && (Type=="SPEND-TRANSFER" || Type=="RECEIVE-TRANSFER")`, 'Date ASC', page), 'bankTransactions', 3, 'Bank transaction'));
    } catch (err) {
      if (_errInfo(err).status !== 400) throw err;
      // Should Xero not take the OR, one read per type.
      legs = [];
      for (const type of ['SPEND-TRANSFER', 'RECEIVE-TRANSFER']) {
        const part = await pages(page => api.getBankTransactions(T, undefined, `${dates} && Type=="${type}"`, 'Date ASC', page),
          'bankTransactions', 2, 'Bank transaction');
        legs.push(...part.list); capped = capped || part.capped;
      }
    }
    return answerQ7({ transfers, legs, window: win, capped });
  });

  await ask(8, 'Does the Bank Summary count unreconciled entries? (last month)', async () => {
    const m = P._monthMeta(today.year, today.month - 1);
    const win = { from: m.startISO, to: m.endISO };
    // The span cash-monthly.js reads its records over, AUTHORISED only.
    const span = `Date >= ${_xd(win.from)} && Date < ${_xd(_addDaysISO(win.to, 1))} && Status=="AUTHORISED"`;
    const rows = await bankSummary(win.from, win.to);
    const pay = await pages(page => api.getPayments(T, undefined, span, 'Date ASC', page), 'payments', 3, 'Payment');
    const btx = await pages(page => api.getBankTransactions(T, undefined, span, 'Date ASC', page), 'bankTransactions', 3, 'Bank transaction');
    return answerQ8({
      rows, payments: pay.list, bankTransactions: btx.list, bankAccounts: await bankAccounts(),
      baseCurrency, window: win, capped: pay.capped || btx.capped,
    });
  });

  await ask(9, "Budget section titles against the code's _sectionKind", async () => {
    if (!q6) throw new Error('Q6 did not return any Budget Summary to read titles from');
    return answerQ9({ sections: q6.sections });
  });

  print('\n══ SUMMARY ══');
  for (const r of results) {
    const ev = String(r.evidence || '').replace(/\s+/g, ' ');
    print(`Q${r.n} ${r.answer} — ${ev.length > 240 ? `${ev.slice(0, 237)}...` : ev}`);
  }
  print(`\nXero calls made: ${stats.calls} (${Object.entries(stats.byMethod).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  return { ok: true, results, calls: stats.calls };
}

// The app's real connection, the way smoke-xero.js reaches it.
function _realDeps() {
  const users = require('../utils/users');
  const tokenCache = require('../utils/token-cache');
  return {
    findUser: email => users.findByEmail(email),
    tenants: userId => tokenCache.getPersistedTenants(userId),
    token: (userId, tenantId) => tokenCache.forUser(userId).getValidToken(tenantId),
    timezone: userId => users.getUserDefaults(userId).timezone,
    apiFor: token => L().fetch._apiFor(token),
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.errors.length) { console.error(`${args.errors.join('\n')}\n\n${USAGE}`); return 2; }
  // Quiet: the app's info logs (token refreshes and fetches) are not wanted
  // here. Set before the logger is first loaded; an explicit LOG_LEVEL wins.
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const watchdog = setTimeout(() => { console.error(`\nStopped: no result after ${RUN_TIMEOUT_MS / 60000} minutes.`); process.exit(3); }, RUN_TIMEOUT_MS);
  watchdog.unref();
  const { ok } = await run({ email: args.email, tenant: args.tenant, deps: _realDeps() });
  return ok ? 0 : 1;
}

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error('cash-live-check crashed:', err?.message || err); process.exit(1); });
}

module.exports = {
  parseArgs, run, main, USAGE, READ_RE, WRITE_RE,
  _readOnly, _pickTenant, _pickOpenSample, _scopesOf, _budgetShape, _bankAmountCents,
  answerQ1, answerQ2, answerQ3, answerQ4, answerQ5, answerQ6, answerQ7, answerQ8, answerQ9,
};
