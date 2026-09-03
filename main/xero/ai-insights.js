// What the language model is shown, and what it is allowed to say back.
//
// Separated from reports.js because it is a different job entirely: reports.js
// fetches and computes, this decides which already-computed figures the model
// may see and discards anything it says that is not grounded in them.
//
// Every function here is PURE. The two functions that actually call Gemini stay
// in reports.js, because they need getPerformance and getCashFlow and requiring
// those back would be circular. That split is the point: the fetching is
// orchestration, and the safety argument lives here where it can be tested
// without a Xero token.

const MIN_VARIANCE_TO_EXPLAIN = 1;           // ignore rounding dust

function _largeNumbersIn(text) {
  return (String(text).match(/-?[\d][\d,]*(?:\.\d+)?/g) || [])
    .map(t => Math.abs(Number(t.replace(/,/g, ''))))
    .filter(n => Number.isFinite(n) && n >= 1000);
}

// Pure. True if every large number in `text` was one we supplied.
function _insightIsGrounded(text, allowed) {
  return _largeNumbersIn(text).every(n => allowed.has(Math.round(n)));
}

// Pure. Builds the 4 universal executive variance categories from computed Xero actuals vs budget.
function _buildCategoryVariances(perf, cf) {
  const cur = perf.organisation?.currency || '';
  const revA = _sum(perf.totals.revenue.actual);
  const revB = _sum(perf.totals.revenue.budget);
  const revV = revA - revB;

  const cogsA = _sum(perf.totals.cogs.actual);
  const cogsB = _sum(perf.totals.cogs.budget);
  const cogsV = cogsA - cogsB;

  const opexA = _sum(perf.totals.opex.actual);
  const opexB = _sum(perf.totals.opex.budget);
  const opexV = opexA - opexB;

  // Top revenue line movers
  const revDrivers = (perf.serviceLines || [])
    .filter(l => !l.otherIncome)
    .map(l => {
      const a = _sum(l.actual), b = _sum(l.budget);
      return { name: l.label, actual: a, budget: b, variance: a - b };
    })
    .sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance))
    .slice(0, 3);

  // Top COGS / direct cost movers
  const cogsDrivers = (perf.expenseLines || [])
    .filter(l => l.kind === 'cogs')
    .map(l => {
      const a = _sum(l.actual), b = _sum(l.budget);
      return { name: l.label, actual: a, budget: b, variance: a - b };
    })
    .sort((x, y) => Math.abs(y.variance) - Math.abs(x.variance))
    .slice(0, 3);

  // Top opex movers
  const opexDrivers = (perf.expenseLines || [])
    .filter(l => l.kind === 'opex')
    .map(l => {
      const a = _sum(l.actual), b = _sum(l.budget);
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

  return [
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
}

// Pure. The variance lines worth explaining, biggest absolute gap first.
function _varianceCandidates(perf, limit = 6) {
  const all = [...perf.serviceLines, ...perf.expenseLines].map(l => {
    const actual = l.actual.reduce((s, v) => s + v, 0);
    const budget = l.budget.reduce((s, v) => s + v, 0);
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

// Pure. Parses the model reply and merges with grounded category and line-item data.
function _parseInsights(raw, arg2, arg3) {
  const isTwoArg = arg3 === undefined;
  const categories = isTwoArg ? [] : (arg2 || []);
  const candidates = isTwoArg ? (arg2 || []) : (arg3 || []);

  let payload;
  try {
    const cleaned = require('../utils/llm-json').stripWrapping(raw);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || start >= end) throw new Error('No JSON');
    payload = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    if (isTwoArg) return [];
    return { categories: categories.map(c => ({ ...c, reason: c.defaultReason })), lines: candidates };
  }

  const allowed = new Set();
  for (const c of candidates) {
    for (const v of [c.actual, c.budget, c.variance]) allowed.add(Math.round(Math.abs(v)));
  }
  for (const cat of categories) {
    for (const v of [cat.actual, cat.budget, cat.variance]) allowed.add(Math.round(Math.abs(v)));
  }

  const byName = new Map(candidates.map(c => [c.account, c]));
  const parsedLines = (payload.reasons || [])
    .map(r => ({ account: String(r.account || '').trim(), reason: String(r.reason || '').trim() }))
    .filter(r => byName.has(r.account) && r.reason)
    .filter(r => _insightIsGrounded(r.reason, allowed))
    .map(r => ({ ...byName.get(r.account), reason: r.reason }));

  if (isTwoArg) {
    return parsedLines;
  }

  const catMap = new Map((payload.categories || []).map(c => [c.key, String(c.reason || '').trim()]));
  const parsedCategories = categories.map(cat => {
    const aiReason = catMap.get(cat.key);
    const reason = (aiReason && _insightIsGrounded(aiReason, allowed)) ? aiReason : cat.defaultReason;
    return { ...cat, reason };
  });

  return { categories: parsedCategories, lines: parsedLines.length ? parsedLines : candidates };
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
    if (Number.isFinite(a.amount)) allowed.add(Math.round(Math.abs(a.amount)));
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

// Everything after the Xero read: prompt, call, ground, cache. Split out so it
// can be tested directly — the fetch is one line of delegation, and keeping them
// together meant the only way to reach this logic in a test was to stand up a
// whole Xero token. "callGemini is not defined" shipped green for exactly that
// reason.

module.exports = { _buildCategoryVariances, _groundNarrative, _insightIsGrounded, _insightPrompt, _largeNumbersIn, _narrativeFacts, _narrativePrompt, _parseInsights, _varianceCandidates };
