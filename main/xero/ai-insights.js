// What the language model is shown, and what it is allowed to say back.
//
// Separated from reports.js because it is a different job entirely: reports.js
// fetches and computes, this decides which already-computed figures the model
// may see and discards anything it says that is not grounded in them.
//
// Every function here is PURE except the two request helpers at the end
// (requestVarianceInsights, requestNarrative), which make the model call over
// figures already computed. The fetching stays in reports.js, because it
// needs getPerformance and getCashFlow and requiring those back would be
// circular. That split is the point: the fetching is orchestration, and the
// safety argument lives here where it can be tested without a Xero token. The
// helpers take callGemini as an argument for the same reason.

const { parseLlmJson, jsonSchemaFormat } = require('../utils/llm-json');

// Left behind by the split: _buildCategoryVariances moved here and _sum stayed
// in reports.js. Not caught by the suite because the only caller reaches these
// lines with data the tests never supply — ESLint's no-undef found it in a
// second, which is the whole argument for having it.
const _sum = a => a.reduce((s, v) => s + v, 0);

const MIN_VARIANCE_TO_EXPLAIN = 1;           // ignore rounding dust

// ── The figure guard ────────────────────────────────────────────────────────
//
// Every figure a model writes is checked against the set of figures we gave
// it. The first version only looked at plain numbers of 1,000 or more, while
// the prompt itself hands the model "SGD 45.2k vs plan" — so "SGD 45.2k",
// "$2.4M" and "12%" were never checked at all, and an invented one passed.
// Now an amount written with k/M/bn is read at its full size, any amount
// carrying a currency is checked whatever its size, and percentages are
// checked too. Plain numbers below 1,000 with no currency or % stay free:
// they are counts of days, months and alerts.

// Listed rather than "any three capitals", so "GST 9%" or "FY 2026" never
// reads as a currency.
const ISO_CODES = ['SGD', 'USD', 'AUD', 'GBP', 'EUR', 'MYR', 'NZD', 'CAD', 'JPY', 'CNY', 'HKD', 'INR', 'IDR', 'THB', 'PHP', 'VND', 'KRW', 'CHF', 'TWD'];
const CURRENCY_MARK = `(?:(?:${ISO_CODES.join('|')})\\s?\\$?|US\\$|S\\$|A\\$|NZ\\$|HK\\$|C\\$|RM|[$£€¥₹])`;
const SCALES = { k: 1e3, K: 1e3, thousand: 1e3, m: 1e6, M: 1e6, mn: 1e6, million: 1e6, B: 1e9, bn: 1e9, billion: 1e9 };
const FIGURE = new RegExp(
  `(${CURRENCY_MARK}\\s?)?([-+−]\\s?)?(\\d[\\d,]*(?:\\.\\d+)?)` +
  '(?:\\s?(thousand|million|billion|mn|bn|[kKmMB])(?![A-Za-z]))?' +
  '(\\s?(?:%|per\\s?cent\\b|percent\\b))?',
  'g'
);
// Dates and times are not figures: "2026-04-21", "21/04/2026", "12:01".
const DATE_OR_TIME = /\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

// Pure. Every figure in `text` the guard has an opinion about, as
// { kind: 'amount' | 'percent', value, tol, policed }. `tol` is how far a
// figure may sit from one of ours and still be the same figure written
// shorter: "45.2k" stands for anything from 45,150 to 45,250.
function _figuresIn(text) {
  const s = String(text ?? '').replace(DATE_OR_TIME, ' ');
  const out = [];
  FIGURE.lastIndex = 0;
  let m;
  while ((m = FIGURE.exec(s)) !== null) {
    const [whole, cur, sign, digits, scale, pct] = m;
    const prev = s[m.index - 1] || '';
    const next = s[m.index + whole.length] || '';
    // Glued to a word, it is part of a name or reference, not a figure:
    // INV-2026099, FY2026, Q3, #1042, 202016196Z, 3rd.
    if (!cur && /[A-Za-z_]/.test(prev)) continue;
    if (!cur && !sign && /[0-9]/.test(prev)) continue;
    if (!cur && /[#/]/.test(prev)) continue;
    if (!scale && !pct && /[A-Za-z0-9_]/.test(next)) continue;

    const value = Math.abs(Number(digits.replace(/,/g, '')));
    if (!Number.isFinite(value)) continue;
    const decimals = (digits.split('.')[1] || '').length;

    if (pct) { out.push({ kind: 'percent', value, tol: 0.5, policed: true }); continue; }
    // A lone "m" is as likely months as millions; it counts as millions only
    // beside a currency.
    const mult = scale && !(scale === 'm' && !cur) ? SCALES[scale] : 1;
    if (mult > 1) {
      out.push({ kind: 'amount', value: value * mult, tol: 0.5 * Math.pow(10, -decimals) * mult, policed: true });
      continue;
    }
    if (cur) { out.push({ kind: 'amount', value, tol: 0.5, policed: true }); continue; }
    // A bare four-digit year is a date, not an amount.
    if (!/[,.]/.test(digits) && value >= 1900 && value <= 2100) continue;
    out.push({ kind: 'amount', value, tol: 0.5, policed: value >= 1000 });
  }
  return out;
}

// Pure. The money figures the guard checks, at full size. The name predates
// the k/M and currency rules; it now also returns a small amount written with
// a currency ("SGD 450"), because that is a claim about money too.
function _largeNumbersIn(text) {
  return _figuresIn(text).filter(f => f.kind === 'amount' && f.policed).map(f => f.value);
}

// Pure. The percentages in `text`.
function _percentsIn(text) {
  return _figuresIn(text).filter(f => f.kind === 'percent').map(f => f.value);
}

function _figureAllowed(f, allowed) {
  const v = f.value;
  if (f.kind === 'percent') return allowed.has(Math.round(v)) || allowed.has(Math.floor(v)) || allowed.has(Math.ceil(v));
  if (allowed.has(Math.round(v))) return true;
  if (f.tol <= 0.5) return false;
  for (const a of allowed) if (Math.abs(a - v) <= f.tol + 0.5) return true;
  return false;
}

// Pure. The figures in `text` that match nothing we supplied.
function _ungroundedFigures(text, allowed) {
  return _figuresIn(text).filter(f => f.policed && !_figureAllowed(f, allowed));
}

// Pure. True if every figure the guard polices in `text` was one we supplied.
function _insightIsGrounded(text, allowed) {
  return _ungroundedFigures(text, allowed).length === 0;
}

// Adds a line's figures to an allowed set, with the percentages a reader may
// fairly say about them: the variance as a share of budget, and actual as a
// share of budget. Both are arithmetic on figures we gave, not invention.
function _allowLine(allowed, { actual, budget, variance }) {
  for (const v of [actual, budget, variance]) if (Number.isFinite(v)) allowed.add(Math.round(Math.abs(v)));
  if (Number.isFinite(budget) && budget !== 0) {
    if (Number.isFinite(variance)) allowed.add(Math.round(Math.abs(variance / budget) * 100));
    if (Number.isFinite(actual))   allowed.add(Math.round(Math.abs(actual / budget) * 100));
  }
}

// ── Closed months ───────────────────────────────────────────────────────────
//
// How many leading months of perf's series are closed. The series run the
// whole period — the month in progress has a few days of actuals, the months
// after it have none, and every one of them carries a full budget — so summing
// all of it under a full-year period compared part of the year's actuals with
// all of the year's budget and called the gap a variance. The budget tab
// compares closed months only (reports.js#_buildBudgetVariance); so does this.
// Null when perf does not say, which keeps the old whole-series behaviour.
function _closedMonthCount(perf) {
  const counts = [perf?.actualThroughIdx, perf?.closedThroughIdx]
    .filter(Number.isInteger)
    .map(i => Math.max(0, i + 1));
  return counts.length ? Math.min(...counts) : null;
}
const _sumClosed = (arr, n) => _sum(n === null ? (arr || []) : (arr || []).slice(0, n));

// Pure. Builds the 4 universal executive variance categories from computed Xero actuals vs budget.
// Closed months only — see _closedMonthCount.
function _buildCategoryVariances(perf, cf) {
  const cur = perf.organisation?.currency || '';
  const n = _closedMonthCount(perf);
  const revA = _sumClosed(perf.totals.revenue.actual, n);
  const revB = _sumClosed(perf.totals.revenue.budget, n);
  const revV = revA - revB;

  const cogsA = _sumClosed(perf.totals.cogs.actual, n);
  const cogsB = _sumClosed(perf.totals.cogs.budget, n);
  const cogsV = cogsA - cogsB;

  const opexA = _sumClosed(perf.totals.opex.actual, n);
  const opexB = _sumClosed(perf.totals.opex.budget, n);
  const opexV = opexA - opexB;

  // Top revenue line movers
  const revDrivers = (perf.serviceLines || [])
    .filter(l => !l.otherIncome)
    .map(l => {
      const a = _sumClosed(l.actual, n), b = _sumClosed(l.budget, n);
      return { name: l.label, actual: a, budget: b, variance: a - b };
    })
    .sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance))
    .slice(0, 3);

  // Top COGS / direct cost movers
  const cogsDrivers = (perf.expenseLines || [])
    .filter(l => l.kind === 'cogs')
    .map(l => {
      const a = _sumClosed(l.actual, n), b = _sumClosed(l.budget, n);
      return { name: l.label, actual: a, budget: b, variance: a - b };
    })
    .sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance))
    .slice(0, 3);

  // Top opex movers
  const opexDrivers = (perf.expenseLines || [])
    .filter(l => l.kind === 'opex')
    .map(l => {
      const a = _sumClosed(l.actual, n), b = _sumClosed(l.budget, n);
      return { name: l.label, actual: a, budget: b, variance: a - b };
    })
    .sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance))
    .slice(0, 3);

  // Cash conversion delta
  const rec = cf?.reconciliation || {};
  const customerReceipts = rec.customerReceipts ?? 0;
  const revenueAccrual   = rec.revenueAccrual ?? revA;
  const cashGap          = customerReceipts - revenueAccrual;
  const dso              = cf?.workingCapital?.dso;
  const overdue          = cf?.workingCapital?.overdue;

  // Helper to format delta text e.g. +$520.00 vs plan
  const fmtDelta = (v) => {
    const s = v >= 0 ? '+' : '-';
    const abs = Math.abs(v);
    const num = abs >= 1000000 ? `${(abs / 1000000).toFixed(2)}M` : abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : `${Math.round(abs)}`;
    return `${s}${cur ? cur + ' ' : '$'}${num} vs plan`;
  };

  const categories = [
    {
      key: 'revenue',
      title: 'Revenue mix',
      status: revV >= 0 ? 'favorable' : 'unfavorable',
      variance: revV,
      actual: revA,
      budget: revB,
      deltaText: fmtDelta(revV),
      topDrivers: revDrivers,
      defaultReason: revV === 0
        ? 'Tracking directly on plan with no material variance.'
        : revV > 0
          ? `Topline revenue is ahead of budget plan${revDrivers[0] ? ` led by ${revDrivers[0].name}` : ''}.`
          : `Revenue fell below planned target${revDrivers[0] ? ` due to softness in ${revDrivers[0].name}` : ''}.`,
    },
    {
      key: 'delivery',
      title: cogsA > 0 || cogsB > 0 ? 'Delivery cost' : (cogsDrivers.length ? 'Direct delivery' : 'Cost of delivery'),
      status: cogsV <= 0 ? 'favorable' : 'unfavorable',
      variance: cogsV,
      actual: cogsA,
      budget: cogsB,
      deltaText: fmtDelta(cogsV),
      topDrivers: cogsDrivers,
      defaultReason: cogsA === 0 && cogsB === 0
        ? 'No direct cost of sales booked in this period.'
        : cogsV <= 0
          ? `Direct delivery and production costs remained within budget${cogsDrivers[0] ? ` with savings in ${cogsDrivers[0].name}` : ''}.`
          : `Delivery and contractor expenses ran above budget${cogsDrivers[0] ? ` driven by higher ${cogsDrivers[0].name}` : ''}.`,
    },
    {
      key: 'opex',
      title: 'Operating expense',
      status: opexV <= 0 ? 'favorable' : 'unfavorable',
      variance: opexV,
      actual: opexA,
      budget: opexB,
      deltaText: fmtDelta(opexV),
      topDrivers: opexDrivers,
      defaultReason: opexV === 0
        ? 'Operating expenses are tracking in line with budget.'
        : opexV <= 0
          ? `Operating discipline delivered cost savings against plan${opexDrivers[0] ? ` across ${opexDrivers[0].name}` : ''}.`
          : `Operating expenses exceeded planned allocation${opexDrivers[0] ? ` primarily due to ${opexDrivers[0].name}` : ''}.`,
    },
    {
      key: 'cash',
      title: 'Cash conversion',
      status: cashGap >= 0 ? 'favorable' : 'unfavorable',
      variance: cashGap,
      actual: customerReceipts,
      budget: revenueAccrual,
      deltaText: fmtDelta(cashGap),
      topDrivers: [],
      defaultReason: cashGap >= 0
        ? 'Customer cash collections kept pace with or exceeded invoiced billing for the period.'
        : `Debtor collection timing${dso ? ` (averaging ${Math.round(dso)} days)` : ''}${overdue ? ` with overdue customer receivables` : ''} explains the gap between accrual revenue and bank cash.`,
    },
  ];
  // Nothing has closed, so nothing is compared — said plainly rather than
  // "tracking on plan", which a row of zeros would otherwise read as.
  if (n === 0) {
    for (const c of categories) {
      if (c.key !== 'cash') c.defaultReason = 'No month of this period has closed yet, so there is nothing to compare with budget.';
    }
  }
  return categories;
}

// Pure. The variance lines worth explaining, biggest absolute gap first.
// Closed months only — see _closedMonthCount.
function _varianceCandidates(perf, limit = 6) {
  const n = _closedMonthCount(perf);
  const all = [...perf.serviceLines, ...perf.expenseLines].map(l => {
    const actual = _sumClosed(l.actual, n);
    const budget = _sumClosed(l.budget, n);
    return { account: l.label, actual, budget, variance: actual - budget };
  });
  return all
    .filter(l => Math.abs(l.variance) >= MIN_VARIANCE_TO_EXPLAIN)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, limit);
}

function _insightPrompt(org, fyLabel, closedMonths, categories, candidates) {
  return [
    {
      role: 'system',
      content: [
        'You are an executive finance analyst writing concise, operational variance reasons for a business management scorecard.',
        'You will receive pre-computed category totals and top account movers from the company\'s real Xero accounting system.',
        'Rules you must follow exactly:',
        '1. NEVER invent, recalculate, estimate or infer any monetary figure. Use only the provided context.',
        '2. For each of the 4 executive categories ("revenue", "delivery", "opex", "cash"), provide a concise 1-2 sentence operational explanation of the likely business driver and what management should check. Refer naturally to their real account names.',
        '3. If a category is on budget (variance 0) or has no data recorded yet, state that plainly.',
        '4. Maintain a crisp, professional tone suitable for presentation to CEOs, CFOs, and company directors.',
        'Reply with JSON only in this exact format:',
        '{"categories":[{"key":"revenue","reason":"..."},{"key":"delivery","reason":"..."},{"key":"opex","reason":"..."},{"key":"cash","reason":"..."}],"reasons":[{"account":"<exact account name>","reason":"..."}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        organisation: org,
        financialYear: fyLabel,
        monthsClosed: closedMonths,
        categories: categories.map(c => ({
          key: c.key,
          title: c.title,
          status: c.status,
          actual: Math.round(c.actual),
          budget: Math.round(c.budget),
          variance: Math.round(c.variance),
          deltaText: c.deltaText,
          topDrivers: c.topDrivers.map(d => `${d.name} (${d.variance >= 0 ? '+' : ''}${Math.round(d.variance)})`),
        })),
        accounts: candidates.map(c => ({
          account: c.account,
          actual: Math.round(c.actual),
          budget: Math.round(c.budget),
          variance: Math.round(c.variance),
        })),
      }),
    },
  ];
}

// The reply's shape, held by the endpoint (llm-json.jsonSchemaFormat). The
// account names are an enum of the candidates the model was shown, so it
// cannot explain an account it was never given — _parseInsights drops those
// anyway, but only after the tokens are spent. The figure guard below still
// runs on every reason: a schema shapes the reply, it does not ground it.
const INSIGHT_KEYS = ['revenue', 'delivery', 'opex', 'cash'];
function _insightResponseFormat(candidates = []) {
  const names = [...new Set(candidates.map(c => c.account).filter(Boolean))];
  return jsonSchemaFormat('variance_insights', {
    type: 'object',
    properties: {
      categories: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string', enum: INSIGHT_KEYS }, reason: { type: 'string' } },
          required: ['key', 'reason'],
        },
      },
      reasons: {
        type: 'array',
        ...(names.length ? {} : { maxItems: 0 }),
        items: {
          type: 'object',
          properties: { account: names.length ? { type: 'string', enum: names } : { type: 'string' }, reason: { type: 'string' } },
          required: ['account', 'reason'],
        },
      },
    },
    required: ['categories', 'reasons'],
  });
}

// How long a fallback may be cached. A reply that did not parse, or a call
// that failed, used to be cached as though the model had answered — labelled
// 'gemini' and kept for the full 30 minutes, so one bad reply hid the
// commentary for half an hour and nothing said why. Long enough not to ask
// again on every page load; short enough that the next visit tries again.
const INSIGHT_FAILURE_TTL_MS = 2 * 60 * 1000;

// The fallback when the model gave nothing usable: the computed default
// reasons and the bare candidates, marked so the caller can tell it from an
// answer — `source: 'figures'`, why in `failed`, and the short TTL.
function _insightFallback(categories, candidates, failed) {
  return {
    categories: categories.map(c => ({ ...c, reason: c.defaultReason })),
    lines: candidates,
    source: 'figures',
    failed,
    cacheTtlMs: INSIGHT_FAILURE_TTL_MS,
  };
}

// Pure. Parses the model reply and merges with grounded category and line-item data.
//
// The three-argument form returns { categories, lines, source } and, when the
// reply could not be read at all, the fallback above with failed: 'unparsed'.
// The two-argument form (accounts only) is the older contract and returns the
// grounded lines, or [] when nothing could be read.
function _parseInsights(raw, arg2, arg3) {
  const isTwoArg = arg3 === undefined;
  const categories = isTwoArg ? [] : (arg2 || []);
  const candidates = isTwoArg ? (arg2 || []) : (arg3 || []);

  // The one lenient reader every model reply goes through (llm-json), rather
  // than a fifth copy of it: a reply in plain JSON mode — after a refused
  // schema — may still arrive fenced or with a sentence around it.
  const payload = parseLlmJson(raw);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    if (isTwoArg) return [];
    return _insightFallback(categories, candidates, 'unparsed');
  }

  // Everything the prompt showed the model: the candidates, the categories and
  // their top drivers (sent as "Name (+1234)", and dropped as invented when
  // quoted back until they were listed here too).
  const allowed = new Set();
  for (const c of candidates) _allowLine(allowed, c);
  for (const cat of categories) {
    _allowLine(allowed, cat);
    for (const d of cat.topDrivers || []) _allowLine(allowed, d);
  }

  const byName = new Map(candidates.map(c => [c.account, c]));
  const parsedLines = (Array.isArray(payload.reasons) ? payload.reasons : [])
    .filter(r => r && typeof r === 'object')
    .map(r => ({ account: String(r.account || '').trim(), reason: String(r.reason || '').trim() }))
    .filter(r => byName.has(r.account) && r.reason)
    .filter(r => _insightIsGrounded(r.reason, allowed))
    .map(r => ({ ...byName.get(r.account), reason: r.reason }));

  if (isTwoArg) {
    return parsedLines;
  }

  const catMap = new Map((Array.isArray(payload.categories) ? payload.categories : [])
    .filter(c => c && typeof c === 'object')
    .map(c => [c.key, String(c.reason || '').trim()]));
  const parsedCategories = categories.map(cat => {
    const aiReason = catMap.get(cat.key);
    const reason = (aiReason && _insightIsGrounded(aiReason, allowed)) ? aiReason : cat.defaultReason;
    return { ...cat, reason };
  });

  return { categories: parsedCategories, lines: parsedLines.length ? parsedLines : candidates, source: 'gemini' };
}

// `force` re-pulls from Xero, which costs API calls and billed egress.
// `reanalyse` only re-runs the model over figures already in hand.

function _narrativePrompt(facts) {
  return `You are a financial analyst writing three short sentences for a business owner looking at their own dashboard.

THE FIGURES (already calculated — use them exactly, never recalculate):
${facts.lines.join('\n')}

ALERTS ALREADY RAISED (these are correct; your job is to connect them, not to re-state each one):
${facts.alerts.length ? facts.alerts.map(a => `- ${a.title}: ${a.detail}`).join('\n') : '- none'}

Write at most 3 short sentences, plain text, no markdown, no bullet points:
1. The ONE thing that matters most, said plainly.
2. Why the separate alerts above are or are not the same underlying issue.
3. The single most useful next step, and only if the figures clearly support it.

Rules:
- DO NOT WRITE ANY MONETARY AMOUNTS. No figures like "SGD 109,330". The reader is
  looking at every one of these numbers on the same screen, so repeating them adds
  nothing and risks attaching an amount to the wrong label. Say "most of what you
  invoiced", "the overdue balance", "the bulk of your cash in" instead.
- Percentages and counts of days or months are fine, but only exactly as given above.
- Never invent, estimate or recalculate anything.
- Do not give business advice beyond what the figures show. Never suggest hiring, firing, pricing or borrowing.
- If the figures look healthy, say so briefly rather than manufacturing a concern.
- Write to the owner as "you". No preamble, no sign-off.`;
}

// Assembles the facts the narrative may refer to, and the set of numbers it is
// allowed to use. Pure and exported, because what the model is permitted to see
// is the whole safety argument.
function _narrativeFacts(cf) {
  const wc = cf.workingCapital || {};
  const rw = cf.runway || {};
  const rec = cf.reconciliation || {};
  const cur = cf.organisation?.currency || '';
  const lines = [];
  const allowed = new Set();
  const add = (label, value, suffix = '') => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
    const n = Number(value);
    lines.push(`- ${label}: ${cur} ${Math.round(n).toLocaleString('en')}${suffix}`);
    allowed.add(Math.round(Math.abs(n)));
  };
  const addRaw = (label, text, numbers = []) => {
    lines.push(`- ${label}: ${text}`);
    for (const n of numbers) if (Number.isFinite(n)) allowed.add(Math.round(Math.abs(n)));
  };

  lines.push(`- Period: ${cf.period?.label || 'current period'}`);
  add('Revenue invoiced (accrual)', rec.revenueAccrual);
  add('Cash actually received from customers', rec.customerReceipts);
  add('Cash at bank now', cf.cash?.closing);
  add('Owed to you by customers', wc.receivable);
  add('Of that, past its due date', wc.overdue);
  add('You owe suppliers', wc.payable);
  if (wc.dso !== null && wc.dso !== undefined && Number.isFinite(wc.dso)) {
    addRaw('Debtor days (how long invoices take to become cash)', `${Math.round(wc.dso)} days`, [Math.round(wc.dso)]);
  }
  if (wc.collectionRate !== null && wc.collectionRate !== undefined) {
    addRaw('Share of invoiced work collected', `${Math.round(wc.collectionRate * 100)}%`, [Math.round(wc.collectionRate * 100)]);
  }
  if (rw.available) {
    add('Average cash in per month', rw.avgCashIn);
    add('Average cash out per month', rw.avgCashOut);
    if (rw.avgOperatingIn !== null && rw.avgOperatingIn !== undefined) {
      add('Of that cash in, the part from customers', rw.avgOperatingIn);
    }
    if (rw.propped) addRaw('Note', 'the balance grew only because of receipts that did not come from customers');
  }

  // Figures inside the alerts are ours as well: they were computed here and
  // handed to the model as ground truth. Quoting one back is correct, and the
  // guard dropped a true sentence for doing so until this was added.
  const alerts = cf.alerts?.alerts || [];
  for (const a of alerts) {
    for (const n of _largeNumbersIn(`${a.title} ${a.detail}`)) allowed.add(Math.round(n));
    // Percentages are checked now as well, and an alert's "52% is past due"
    // is ours to quote back.
    for (const p of _percentsIn(`${a.title} ${a.detail}`)) allowed.add(Math.round(p));
    if (Number.isFinite(a.amount)) allowed.add(Math.round(Math.abs(a.amount)));
  }

  // Who the money goes to. The model was given "You owe suppliers: 24,603" and
  // nothing about WHOM, so neither the narrative nor the chat assistant could
  // answer "who do I spend the most with" from a figure sitting on screen.
  const spend = cf.supplierSpend;
  if (spend?.available) {
    add('Billed by suppliers this period', spend.total);
    if (spend.topShare !== null && spend.topShare !== undefined && spend.suppliers?.length) {
      addRaw('Largest supplier',
        `${spend.suppliers[0].name} — ${Math.round(spend.topShare * 100)}% of billed spend`,
        [Math.round(spend.topShare * 100), Math.round(spend.suppliers[0].spend)]);
    }
    // A handful, not the whole ledger: the model needs the shape, not the list.
    for (const sup of spend.suppliers.slice(0, 3)) add(`Spend with ${sup.name}`, sup.spend);
  }

  return { lines, allowed, alerts };
}

// Keeps only sentences whose numbers we supplied. A model inventing a
// plausible-looking amount inside financial commentary is the failure that
// matters, and it is cheap to detect.
function _groundNarrative(text, allowed) {
  const sentences = String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(t => t.trim())
    .filter(Boolean);
  const kept = sentences.filter(t => _insightIsGrounded(t, allowed));
  return { text: kept.join(' '), dropped: sentences.length - kept.length };
}

// Pure. The same test as _groundNarrative, for text rendered as markdown (the
// chat assistant's replies). _groundNarrative folds every newline into a
// space, which would flatten a table into one line; this keeps the layout.
// A table row is one claim and stays or goes whole; any other line is
// checked sentence by sentence, keeping its list or heading marker.
function _groundMarkdown(text, allowed) {
  const kept = [];
  const unmatched = [];
  let dropped = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) { kept.push(line); continue; }
    if (/^\s*\|/.test(line)) {
      const bad = _ungroundedFigures(line, allowed);
      if (bad.length) { dropped++; unmatched.push(...bad.map(f => f.value)); } else kept.push(line);
      continue;
    }
    const [, marker = '', body = ''] = line.match(/^(\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?)?)(.*)$/) || [];
    const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
    const good = [];
    for (const s of sentences) {
      const bad = _ungroundedFigures(s, allowed);
      if (bad.length) { dropped++; unmatched.push(...bad.map(f => f.value)); } else good.push(s);
    }
    if (good.length) kept.push(marker + good.join(' '));
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped, unmatched };
}

// Pure. Every figure in `text`, as numbers an allowed set can hold: amounts at
// full size and rounded, percentages rounded. For building an allowed set from
// text the model was shown, so a figure it quotes back from that text matches.
function _allowedFromText(text, allowed = new Set()) {
  for (const f of _figuresIn(text)) allowed.add(Math.round(f.value));
  return allowed;
}

// Everything after the Xero read: prompt, call, ground, cache. Split out so it
// can be tested directly — the fetch is one line of delegation, and keeping them
// together meant the only way to reach this logic in a test was to stand up a
// whole Xero token. "callGemini is not defined" shipped green for exactly that
// reason.

const _isTruncation = err => !!err && err.code === 'GEMINI_TRUNCATED';
const _logger = () => require('../utils/logger');
const _gemini = deps => deps.callGemini || require('../utils/gemini-client').callGemini;

// The variance commentary: prompt, call (with the reply held to the schema
// above), parse and ground. Never throws. Returns what the caller caches —
// { categories, lines, source } — plus cacheTtlMs, which is null for an answer
// (the caller's own TTL applies) and INSIGHT_FAILURE_TTL_MS for a fallback.
// `failed` says which fallback: 'unparsed', 'truncated' or 'unavailable'.
//
// No retry. The call has already been rotated across every model and key by
// gemini-client, and a cut-off reply already had its one larger retry there;
// the short TTL is what gives the next visit another try.
async function requestVarianceInsights(userId, { org, fyLabel, closed, categories = [], candidates = [] }, deps = {}) {
  const callGemini = _gemini(deps);
  let raw;
  try {
    raw = await callGemini(userId, _insightPrompt(org, fyLabel, closed, categories, candidates), {
      temperature: 0.2, maxTokens: 800, responseFormat: _insightResponseFormat(candidates),
    });
  } catch (err) {
    const failed = _isTruncation(err) ? 'truncated' : 'unavailable';
    _logger().warn('Variance insights model unavailable, using computed defaults', { userId, failed, error: err.message });
    return _insightFallback(categories, candidates, failed);
  }
  const out = _parseInsights(raw?.message?.content ?? raw?.content ?? raw, categories, candidates);
  if (out.failed) {
    _logger().warn('Variance insights reply could not be read, using computed defaults', { userId, failed: out.failed });
    return out;
  }
  return { ...out, cacheTtlMs: null };
}

// The dashboard narrative's request. Plain sentences, not JSON, so no schema.
function _narrativeMessages(facts) {
  return [
    { role: 'system', content: 'You are a careful financial analyst. Return plain sentences only.' },
    { role: 'user',   content: _narrativePrompt(facts) },
  ];
}

// Long enough for a rate limit to ease. Nothing waits on this — the card is
// fetched separately from the figures — so a pause costs the reader nothing.
const NARRATIVE_RETRY_DELAY_MS = 2500;

// Asks for the narrative: two attempts, with a pause between them, because
// callGemini has already rotated through every model and key before it throws
// and an immediate retry re-sends a request that just failed on all of them.
//
// Except after a cut-off reply. gemini-client has already asked again with a
// larger limit, so the identical request stops at the identical place — the
// second attempt was a wasted call on the user's quota, two and a half
// seconds later. It now gives up at once.
//
// Never throws. Returns { raw, reason }: raw is the model's text, or null
// with reason 'truncated' or 'unavailable'.
async function requestNarrative(userId, facts, deps = {}) {
  const callGemini = _gemini(deps);
  const attempts = deps.attempts ?? 2;
  const delayMs  = deps.delayMs ?? NARRATIVE_RETRY_DELAY_MS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, delayMs));
    try {
      const raw = await callGemini(userId, _narrativeMessages(facts), { temperature: 0.2, maxTokens: 350 });
      return { raw, reason: null };
    } catch (err) {
      _logger().warn('Financial narrative attempt failed', { userId, attempt, error: err.message });
      if (_isTruncation(err)) return { raw: null, reason: 'truncated' };
    }
  }
  return { raw: null, reason: 'unavailable' };
}

module.exports = {
  _buildCategoryVariances, _groundNarrative, _groundMarkdown, _insightIsGrounded, _insightPrompt,
  _largeNumbersIn, _percentsIn, _figuresIn, _ungroundedFigures, _allowedFromText, _closedMonthCount,
  _narrativeFacts, _narrativePrompt, _parseInsights, _varianceCandidates,
  _insightResponseFormat, _narrativeMessages, INSIGHT_FAILURE_TTL_MS, NARRATIVE_RETRY_DELAY_MS,
  requestVarianceInsights, requestNarrative,
};
