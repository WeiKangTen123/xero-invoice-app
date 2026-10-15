// The Cash Flow Manager tab's decisions: which days the window covers, which
// days before today are shown as they happened, what the chart draws and how
// its axis is ruled, what colour a balance is, what the tiles say, which
// items each list shows and how it groups them, what a date's marker reads,
// what a form may send, and how the calendar lays out.
//
// Plain functions with no imports, so main/scripts/cash-manager-ui.test.js
// can load and run them against a payload; the tab (CashManagerTab.jsx) and
// its chart, lists and dialogs only lay them out.
//
// Every date is an ISO day ('2026-10-12') and is read from the string, with
// day arithmetic in UTC, so no reader's timezone can move an invoice onto the
// day before. "Today" is the server's (payload.today): it is the company's
// day, which is the one Xero dates things in.

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAYS = [30, 60, 90];
const VIEWS = ['chart', 'table', 'calendar'];
const MODES = ['inout', 'balance', 'net'];
const FILTERS = ['current', 'overdue', 'excluded', 'all'];
const GROUPS = ['none', 'contact', 'due'];
// Quarterly is for GST and BAS, which are paid every three months.
const FREQUENCIES = ['once', 'daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];
// What the tab opens on the first time: two months ahead, as a chart of what
// comes in and goes out — Xero's own default view.
const DEFAULT_PREFS = { days: 60, view: 'chart', mode: 'inout' };
// The longest description the server keeps, so the form refuses what the
// server would.
const DESCRIPTION_MAX = 120;
// Below this width the chart shows only the last week before today: thirty
// more slots on a phone would leave the projection's bars a pixel wide.
const PHONE_WIDTH = 600;
const PHONE_ACTUAL_DAYS = 7;
// What the screen says when the server could not read the days before today.
const PAST_UNAVAILABLE = 'Past cash unavailable';
// What the screen says when today's bank balance could not be read, by which
// of Xero's reads failed (the server's bank.unavailableReason), and in place
// of the figure itself.
const BANK_UNAVAILABLE = {
  summary:  'Xero\'s Bank Summary could not be read just now',
  accounts: 'Xero\'s list of bank accounts could not be read, so which accounts count is unknown',
};
const BANK_UNAVAILABLE_ANY = 'Xero\'s bank balances could not be read just now';
const UNAVAILABLE = 'Unavailable';
// Where an item's date would be when Xero holds none for it.
const NO_DATE = 'No date in Xero';
// A shift of more than ten years is a slip of the keyboard, not a plan.
const SHIFT_MAX = 3650;
// The server's bounds: no amount past a billion, no date outside 1990–2100.
const AMOUNT_MAX = 1e9;
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const mag = v => Math.abs(num(v));
const cents = v => Math.round(num(v) * 100);
// A figure the server sends as null when it is not known: it stays null, so
// it is never shown or drawn as a nil a reader would take for a fact.
const known = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ── The choices the controls offer ──────────────────────────────────────────

export function daysOptions() {
  return DAYS.map(d => ({ key: d, label: `${d} days` }));
}

export function viewOptions() {
  return [{ key: 'chart', label: 'Chart' }, { key: 'table', label: 'Table' }, { key: 'calendar', label: 'Calendar' }];
}

export function modeOptions() {
  return [
    { key: 'inout',   label: 'Cash in & cash out' },
    { key: 'balance', label: 'Bank balance' },
    { key: 'net',     label: 'Net movement' },
  ];
}

export function filterOptions() {
  return [
    { key: 'current',  label: 'Current' },
    { key: 'overdue',  label: 'Overdue' },
    { key: 'excluded', label: 'Excluded' },
    { key: 'all',      label: 'All' },
  ];
}

export function groupOptions() {
  return [{ key: 'none', label: 'None' }, { key: 'contact', label: 'Contact' }, { key: 'due', label: 'Due date' }];
}

export function repeatOptions() {
  return [
    { key: 'once',        label: 'Once' },
    { key: 'daily',       label: 'Daily' },
    { key: 'weekly',      label: 'Weekly' },
    { key: 'fortnightly', label: 'Fortnightly' },
    { key: 'monthly',     label: 'Monthly' },
    { key: 'quarterly',   label: 'Quarterly' },
    { key: 'yearly',      label: 'Yearly' },
  ];
}

// A window of 30, 60 or 90 days; anything else is the default 60.
export function normaliseDays(days) {
  const d = Number(days);
  return DAYS.includes(d) ? d : DEFAULT_PREFS.days;
}

// The view, chart mode and window remembered from the last visit, from what
// was stored (a JSON string, or nothing in a private window). Each is checked
// on its own, so one stale value does not throw away the other two.
export function readPrefs(raw) {
  let p = raw;
  if (typeof raw === 'string') {
    try { p = JSON.parse(raw); } catch { p = null; }
  }
  if (!p || typeof p !== 'object') return { ...DEFAULT_PREFS };
  return {
    days: normaliseDays(p.days),
    view: VIEWS.includes(p.view) ? p.view : DEFAULT_PREFS.view,
    mode: MODES.includes(p.mode) ? p.mode : DEFAULT_PREFS.mode,
  };
}

// The query the exports and the check against Xero take: the organisation,
// once known, and the window on screen, so a PDF is the forecast looked at.
export function exportQueryFor({ tenantId, days } = {}) {
  const q = {};
  if (tenantId) q.tenantId = tenantId;
  q.days = String(normaliseDays(days));
  return q;
}

// The organisation every request from the tab names. The page's choice holds
// only while it is still among the organisations connected, which the
// forecast lists (payload.tenants, read when it was): after a disconnect the
// page can still hold the one that went, and every change, export and the
// monthly view sent for it would be refused. Then it is the one the server
// answered for, else the first connected. '' when none is connected. Before
// the forecast has landed there is no list to check against, so the page's
// choice stands.
export function connectedTenant(tenantId, payload) {
  if (payload?.connected === false) return '';
  if (!Array.isArray(payload?.tenants)) return tenantId || payload?.activeTenantId || '';
  const ids = payload.tenants.map(t => t?.tenantId).filter(Boolean);
  return [tenantId, payload.activeTenantId].find(id => id && ids.includes(id)) || ids[0] || '';
}

// ── Today's bank balance ────────────────────────────────────────────────────

// Whether today's bank balance is known. A forecast that says the bank could
// not be read is not, whatever figure it carries: a server from before the
// balance was sent as null sent zero then, and a projection from zero is not
// the company's.
export function bankKnown(payload) {
  const bank = payload?.bank || {};
  if (bank.available === false) return false;
  return known(payload?.tiles?.bankBalance ?? bank.balance) !== null;
}

// Why the balance is not known, in a line, by which of Xero's reads failed;
// '' when it is known.
export function bankUnavailableText(payload) {
  if (bankKnown(payload)) return '';
  return BANK_UNAVAILABLE[payload?.bank?.unavailableReason] || BANK_UNAVAILABLE_ANY;
}

// ── Dates ───────────────────────────────────────────────────────────────────

function parts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

// Whether a string is a real calendar day: '2026-02-30' is not.
export function isIsoDate(iso) {
  const p = parts(iso);
  if (!p) return false;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return t.getUTCFullYear() === p.y && t.getUTCMonth() === p.m - 1 && t.getUTCDate() === p.d;
}

function utc(iso) {
  const p = parts(iso);
  return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN;
}

function isoOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// The day `n` days after `iso` (before it, for a negative n).
export function addDays(iso, n) {
  const t = utc(iso);
  return Number.isNaN(t) ? '' : isoOf(t + Math.trunc(num(n)) * 86400000);
}

// '2026-10-14' -> '14 Oct 2026'.
export function longDay(iso) {
  const p = isIsoDate(iso) && parts(iso);
  return p ? `${p.d} ${MONTH_ABBR[p.m - 1]} ${p.y}` : '';
}

// '2026-10-14' -> '14 Oct', for the chart's axis, where the year is the
// window's and saying it under every bar is noise.
export function shortDay(iso) {
  const p = isIsoDate(iso) && parts(iso);
  return p ? `${p.d} ${MONTH_ABBR[p.m - 1]}` : '';
}

// '2026-10-14' -> 'Wed 14 Oct', for a row or a tooltip, where the weekday is
// what tells a reader whether money lands before the weekend.
export function weekdayDay(iso) {
  if (!isIsoDate(iso)) return '';
  return `${WEEKDAY_ABBR[new Date(utc(iso)).getUTCDay()]} ${shortDay(iso)}`;
}

// ── The window ──────────────────────────────────────────────────────────────

// The days on screen: today and the `days` after it, from the server's
// series, as Xero counts a window: its "60 days" runs from 6 Oct to 5 Dec, the
// day sixty days on. The last of them is the heading's, "Projected for 60
// days ending on 11 Dec 2026", so it names the day Xero's does; it named the
// day before, a day short of Xero's, when the window was the first 60 days.
// A short series (a payload from a server with a shorter horizon) is taken as
// it is, and the heading counts what is there.
export function windowOf(payload, days) {
  const all = Array.isArray(payload?.series) ? payload.series : [];
  const n = Math.min(normaliseDays(days) + 1, all.length);
  const series = all.slice(0, n);
  const ahead = Math.max(0, n - 1);
  const start = series[0]?.date || payload?.today || '';
  const end = series[n - 1]?.date || '';
  return {
    days: ahead, series, start, end,
    endLabel: longDay(end),
    title: n ? `Projected for ${ahead} day${ahead === 1 ? '' : 's'} ending on ${longDay(end)}` : 'Nothing projected yet',
  };
}

// How many of the days before today the chart shows at a width: all of them
// where there is room, the last week on a phone. Graph days counts only the
// days ahead; these are always shown before them. The table and the calendar
// show every one.
export function actualDaysFor(width) {
  const w = num(width);
  return w > 0 && w < PHONE_WIDTH ? PHONE_ACTUAL_DAYS : null;
}

// The days before today the server sent (what actually moved), oldest first,
// the last `count` of them, or all when `count` is null. `note` is what the
// screen says when the server could not read them, so it says so rather than
// drawing nothing as nil; a payload from before they existed has none and
// says nothing.
export function actualWindow(payload, count = null) {
  const all = (Array.isArray(payload?.actuals) ? payload.actuals : []).filter(a => a && isIsoDate(a.date));
  const n = count === null || count === undefined ? all.length : Math.max(0, Math.min(all.length, Math.floor(num(count))));
  const bank = bankKnown(payload);
  const rows = (n ? all.slice(-n) : []).map(a => {
    const cin = mag(a.in), cout = mag(a.out);
    return {
      date: a.date, actual: true, in: cin, out: cout,
      net: a.net === undefined || a.net === null ? cin - cout : num(a.net),
      // Null when there was no balance today to work back from: a line
      // drawn at zero would be a balance nobody had.
      balance: bank ? known(a.balance) : null,
    };
  });
  return { rows, note: payload?.actualsAvailable === false ? PAST_UNAVAILABLE : '' };
}

// Whether a date is one of the days before today the server sent, which is
// how a click on one finds what moved on it rather than what is expected.
function isActualDay(payload, date) {
  return isIsoDate(date) && !!payload?.today && date < payload.today
    && Array.isArray(payload?.actuals) && payload.actuals.some(a => a?.date === date);
}

// How many days apart the axis labels sit so that at most `maxLabels` fit:
// a whole number of days that reads as a rhythm (every 2nd, 3rd, 5th day, or
// weekly, fortnightly) rather than every 9th, which no one counts in.
export function labelStep(count, maxLabels = 10) {
  const room = Math.max(1, Math.floor(num(maxLabels)));
  for (const step of [1, 2, 3, 5, 7, 14, 28]) {
    if (Math.ceil(count / step) <= room) return step;
  }
  return Math.ceil(count / room);
}

// ── The chart ───────────────────────────────────────────────────────────────

function modeOf(mode) {
  return MODES.includes(mode) ? mode : DEFAULT_PREFS.mode;
}

// What the chart draws for the window. `points` are the days from today, each
// with its cash in and out (as amounts, both positive), net movement and the
// projected bank balance at the end of the day; `tick` marks the days that
// get an axis label. `actual` are the days before today as they happened
// (the last `actualDays` of them, all when null), drawn muted left of
// everything else, their balance line too under "Bank balance"; `actualNote`
// says when they could not be read. `overdue` is the pair drawn left of the
// today line — what was due before today and has not been paid — and is left
// out of the bank balance line, which is a projection from today. `min` and
// `max` are the span the values reach, always taking in zero so the bars
// stand on a real baseline; under "Bank balance" the overdraft limit is taken
// in too once the balance goes below zero, so the reader can see how close it
// runs. `empty` is about the days ahead and the overdue pair only: what moved
// before today is not something expected. With today's balance unknown every
// balance is null and no line is drawn: one from zero would be a balance
// nobody had. `balanceNote` says so under "Bank balance", and why.
export function chartBars(payload, days, mode, { maxLabels = 10, actualDays = null } = {}) {
  const m = modeOf(mode);
  const { series } = windowOf(payload, days);
  const step = labelStep(series.length, maxLabels);
  const bank = bankKnown(payload);
  const overdraft = bank ? Math.max(0, num(payload?.bank?.overdraft)) : 0;
  const points = series.map((s, i) => {
    const cin = mag(s.in), cout = mag(s.out);
    const net = s.net === undefined || s.net === null ? cin - cout : num(s.net);
    return { date: s.date, label: shortDay(s.date), tick: i % step === 0, in: cin, out: cout, net, balance: bank ? known(s.balance) : null };
  });
  const past = actualWindow(payload, actualDays);
  const actual = past.rows.map(a => ({ ...a, label: shortDay(a.date) }));

  let overdue = null;
  if (m !== 'balance') {
    const od = payload?.tiles?.overdue || {};
    const oin = mag(od.in), oout = mag(od.out);
    overdue = { in: oin, out: oout, net: od.net === undefined || od.net === null ? oin - oout : num(od.net) };
  }

  let values;
  if (m === 'inout') {
    values = [...actual, ...points].flatMap(p => [p.in, -p.out]);
    if (overdue) values.push(overdue.in, -overdue.out);
  } else if (m === 'net') {
    values = [...actual, ...points].map(p => p.net);
    if (overdue) values.push(overdue.net);
  } else {
    values = [...actual, ...points].filter(p => p.balance !== null).map(p => p.balance);
    if (overdraft > 0 && values.some(v => v < 0)) values.push(-overdraft);
  }
  return {
    mode: m, points, actual, actualNote: past.note, overdue, overdraft, step,
    balanceNote: m === 'balance' && !bank ? `No balance line until the bank balance is known: ${bankUnavailableText(payload)}.` : '',
    min: Math.min(0, ...values),
    max: Math.max(0, ...values),
    empty: points.every(p => !cents(p.in) && !cents(p.out)) && !(overdue && (cents(overdue.in) || cents(overdue.out))),
  };
}

// A step for the axis that a reader can count in: 1, 2, 2.5 or 5 times a
// power of ten, near the span divided into `count` parts.
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// The currency's sign for the axis, where a code beside every tick would
// crowd it: '$' for the dollar currencies Xero is most used in. A currency
// without a well-known sign gets none, and the footnote names it.
export function currencySymbol(code) {
  const c = String(code || '').toUpperCase();
  if (['USD', 'AUD', 'NZD', 'SGD', 'CAD', 'HKD', 'FJD'].includes(c)) return '$';
  return { GBP: '£', EUR: '€', JPY: '¥', CNY: '¥', INR: '₹', PHP: '₱', MYR: 'RM', ZAR: 'R' }[c] || '';
}

// A figure in a few characters, for an axis tick or a calendar day:
// 50000 -> '$50K', -2500 -> '-$2.5K', 1250000 -> '$1.25M'.
export function compactAmount(v, symbol = '') {
  const n = num(v);
  const a = Math.abs(n);
  if (!cents(a)) return `${symbol}0`;
  const [div, unit] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
  const q = a / div;
  // Two decimals at most, trailing zeros dropped; past 100 of a unit the
  // decimals are noise.
  const txt = String(Number(q.toFixed(q >= 100 ? 0 : div === 1 ? 2 : q >= 10 ? 1 : 2)));
  return `${n < 0 ? '-' : ''}${symbol}${txt}${unit}`;
}

// The y-axis for values from `min` to `max`: round ticks a step apart that
// take in both ends and zero, and their labels in the "$50K" style. A flat
// window (nothing expected) still gets an axis, ruled to a thousand, so the
// empty chart reads as "nothing" rather than as broken.
export function axisTicks(min, max, { count = 4, symbol = '' } = {}) {
  let lo = Math.min(0, num(min));
  let hi = Math.max(0, num(max));
  if (hi - lo === 0) hi = lo + 1000;
  const step = niceStep((hi - lo) / Math.max(1, count));
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const ticks = [];
  for (let k = first; k <= last; k++) ticks.push(Number((k * step).toPrecision(12)) || 0);
  return {
    ticks, step,
    min: ticks[0], max: ticks[ticks.length - 1],
    labels: ticks.map(t => compactAmount(t, symbol)),
  };
}

// The colour of a projected balance: green at or above zero, orange while it
// is below zero but within the overdraft limit, red past the limit (or below
// zero with no limit set). Read in cents, so a balance a hair under zero from
// adding up floats is not called overdrawn.
export function balanceColour(balance, overdraft = 0) {
  const b = cents(balance);
  const limit = Math.max(0, cents(overdraft));
  if (b >= 0) return 'var(--success)';
  if (b >= -limit) return 'var(--warning)';
  return 'var(--danger)';
}

// A movement's colour: green in, red out, none for nil.
export function signColour(v) {
  const c = cents(v);
  return c > 0 ? 'var(--success)' : c < 0 ? 'var(--danger)' : undefined;
}

// ── The tiles ───────────────────────────────────────────────────────────────

// The five tiles across the top, in Xero's order: the balance the forecast
// starts from, then the movement today, over the next week, over the rest of
// the month, and what is overdue. A movement tile's figure is its net; what
// came in and went out are kept beside it for the line under the figure.
// A balance that could not be read is null, `text` says "Unavailable" in its
// place and `note` why, with no overdraft limit or runway beside it: both are
// read against a balance nobody knows.
export function tileFigures(payload) {
  const t = payload?.tiles || {};
  const bank = payload?.bank || {};
  const move = (key, label) => {
    const m = t[key] || {};
    const cin = mag(m.in), cout = mag(m.out);
    const value = m.net === undefined || m.net === null ? cin - cout : num(m.net);
    return { key, label, kind: 'movement', value, in: cin, out: cout, tone: signColour(value) };
  };
  const isKnown = bankKnown(payload);
  const balance = isKnown ? known(t.bankBalance ?? bank.balance) : null;
  const overdraft = isKnown ? Math.max(0, num(bank.overdraft)) : 0;
  const runway = isKnown ? known(payload?.runwayDays) : null;
  return [
    {
      key: 'bank', label: 'Today\'s bank balance', kind: 'balance', value: balance,
      text: isKnown ? '' : UNAVAILABLE, note: bankUnavailableText(payload),
      date: longDay(payload?.today), overdraft, runwayDays: runway,
      tone: isKnown && cents(balance) < 0 ? balanceColour(balance, overdraft) : undefined,
    },
    move('today', 'Today\'s movement'),
    move('next7', 'Next 1–7 days movement'),
    move('next8to30', 'Next 8–30 days movement'),
    move('overdue', 'Overdue (net)'),
  ];
}

// ── The lists ───────────────────────────────────────────────────────────────

// An item's place under each filter. Overdue is the server's word: past its
// due date with no later date to expect it on. Moving an overdue invoice to a
// date ahead (a change made here, or an expected date set in Xero) makes it
// current again, which is how Xero's own manager treats it. An excluded item
// is under Excluded alone, whatever its date, since it counts nowhere else.
function inFilter(item, filter) {
  if (filter === 'all') return true;
  if (filter === 'excluded') return !!item.excluded;
  if (item.excluded) return false;
  return filter === 'overdue' ? !!item.overdue : !item.overdue;
}

// Who an item is with, for the Contact column and the grouping: the contact
// Xero names, or for an entry made here, that it is one.
export function contactOf(item) {
  if (item?.contactName) return item.contactName;
  return item?.source === 'manual' ? 'Your entry' : 'No contact';
}

// The Number / Description column: an invoice or bill by its number, with
// its reference under it; an entry made here by its description.
export function itemTitle(item) {
  const number = item?.number || '';
  const text = item?.description || item?.reference || '';
  if (number) return { primary: number, secondary: text };
  return { primary: text || (item?.source === 'manual' ? 'Your entry' : '—'), secondary: '' };
}

// The Expected date column: the day, or for an item Xero holds no date for
// (the server's dateBasis 'none', which stands with the overdue items until a
// date is set here) that it has none.
export function itemDateText(item) {
  return longDay(item?.date) || (item?.dateBasis === 'none' || !item?.date ? NO_DATE : '—');
}

// The credit notes the server netted off an item, already taken out of its
// amount: 0 when none were.
export function creditOf(item) {
  return cents(item?.creditApplied) > 0 ? num(item.creditApplied) : 0;
}

// In date order, an item with no date last, as its group is.
const byDateThenContact = (a, b) => (!a.date) - (!b.date)
  || String(a.date || '').localeCompare(String(b.date || ''))
  || contactOf(a).localeCompare(contactOf(b))
  || String(a.number || '').localeCompare(String(b.number || ''));

const sumOf = rows => rows.reduce((s, r) => s + mag(r.amount), 0);

// One side's list — cash in (invoices, money to come) or cash out (bills) —
// under a filter, in date order, grouped as asked: not at all, by contact
// (alphabetical), or by due date (earliest first; entries made here have no
// due date and are grouped by their own date; an item Xero holds no date for
// is under its own group, last). Each group carries its total, and the foot
// three: everything shown, what of it the forecast counts, and what of it is
// excluded; and `credit`, the credit notes netted off what is shown, which
// the amounts are already after. `counts` is how many items each filter
// would show, for the filter buttons.
export function listRows(items, direction, { filter = 'current', groupBy = 'none' } = {}) {
  const f = FILTERS.includes(filter) ? filter : 'current';
  const g = GROUPS.includes(groupBy) ? groupBy : 'none';
  const mine = (Array.isArray(items) ? items : []).filter(i => i && i.direction === direction);
  const counts = Object.fromEntries(FILTERS.map(k => [k, mine.filter(i => inFilter(i, k)).length]));
  const shown = mine.filter(i => inFilter(i, f)).sort(byDateThenContact);

  let groups;
  if (g === 'none') {
    groups = shown.length ? [{ key: 'all', label: '', rows: shown, total: sumOf(shown) }] : [];
  } else {
    const map = new Map();
    for (const item of shown) {
      const due = item.dueDate || item.date || '';
      const key = g === 'contact' ? contactOf(item) : due;
      if (!map.has(key)) {
        const label = g === 'contact' ? key : (due ? `${item.dueDate ? 'Due' : 'Dated'} ${longDay(due)}` : NO_DATE);
        map.set(key, { key, label, rows: [] });
      }
      map.get(key).rows.push(item);
    }
    groups = [...map.values()]
      .sort((a, b) => (g === 'contact'
        ? a.key.localeCompare(b.key)
        : (a.key === '') - (b.key === '') || a.key.localeCompare(b.key)))
      .map(grp => ({ ...grp, total: sumOf(grp.rows) }));
  }

  const excludedRows = shown.filter(i => i.excluded);
  return {
    filter: f, groupBy: g, groups, counts,
    count: shown.length,
    total: sumOf(shown),
    counted: sumOf(shown.filter(i => !i.excluded)),
    excluded: sumOf(excludedRows),
    excludedCount: excludedRows.length,
    credit: shown.reduce((s, i) => s + cents(creditOf(i)), 0) / 100,
  };
}

// The small marker beside an expected date, saying where the date came from.
const BASIS = {
  override:  ['Changed here', 'A date set in this app. Xero is unchanged.'],
  expected:  ['Expected',     'The expected payment date set on the invoice in Xero.'],
  planned:   ['Planned',      'The planned payment date set on the bill in Xero.'],
  predicted: ['Predicted',    'Predicted from how this contact has paid before.'],
  due:       ['Due',          'The due date in Xero: no expected date is set and there is no payment history to predict from.'],
  scheduled: ['Repeating',    'The next date of a repeating invoice or bill in Xero.'],
  payment:   ['Payment',      'The date of a payment recorded in Xero.'],
  banktx:    ['Spend/Receive Money dated ahead', 'A Spend Money or Receive Money transaction entered in Xero with a date after today, on that date.'],
  manual:    ['Your entry',   'An entry made in this app. Xero is unchanged.'],
  actual:    ['Actual',       'Money that moved: a payment or bank transaction recorded in Xero on this day.'],
  none:      [NO_DATE,        'Xero holds no date for this item, so it stands with the overdue ones. Set a date on it to place it.'],
};

export function basisLabel(dateBasis) {
  return BASIS[dateBasis]?.[0] || '';
}

export function basisHint(dateBasis) {
  return BASIS[dateBasis]?.[1] || '';
}

// Whether an amount was changed here, so the list can say what Xero holds.
// Credit notes netted off are not a change made here: Xero's amount less
// them is the amount as Xero has it.
export function amountChanged(item) {
  return !!item?.overridden && item.originalAmount !== undefined && item.originalAmount !== null
    && cents(item.originalAmount) - cents(creditOf(item)) !== cents(item.amount);
}

// ── The forms ───────────────────────────────────────────────────────────────

// An amount as typed: '1,250.5' is 1250.5. Thousands separators are allowed,
// since that is how people copy figures; anything else that is not a number
// is not one.
function cleanAmount(v) {
  return String(v ?? '').trim().replace(/,/g, '');
}

// What is wrong with an amount, or '' when nothing is. The server's rule:
// more than zero (an override may be nil, an adjustment negative), no more
// than two decimal places, and no more than a billion.
export function amountError(v, { allowNegative = false, allowZero = false } = {}) {
  const s = cleanAmount(v);
  if (!s) return 'Enter an amount';
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return 'Enter an amount, like 1250.00';
  const n = Number(s);
  if (n < 0 && !allowNegative) return allowZero ? 'The amount cannot be negative' : 'The amount must be more than zero';
  if (n === 0 && !allowZero) return 'The amount must be more than zero';
  if ((s.split('.')[1] || '').length > 2) return 'Use at most two decimal places';
  if (Math.abs(n) > AMOUNT_MAX) return 'The amount cannot be more than 1,000,000,000';
  return '';
}

// What is wrong with a date the server is to keep, or '' when nothing is: a
// real day, in the years it accepts.
export function dayError(iso, what = 'a date') {
  if (!isIsoDate(iso)) return `Choose ${what}`;
  const y = Number(String(iso).slice(0, 4));
  return y < YEAR_MIN || y > YEAR_MAX ? `Choose ${what} between ${YEAR_MIN} and ${YEAR_MAX}` : '';
}

export function toAmount(v) {
  return Number(cleanAmount(v)) || 0;
}

// A blank entry: today, once, for the side the reader is on.
export function emptyEntryForm(today, direction = 'in') {
  return { direction: direction === 'out' ? 'out' : 'in', description: '', amount: '', date: isIsoDate(today) ? today : '', frequency: 'once', endDate: '' };
}

// An entry the server holds, as the form edits it.
export function entryForm(entry) {
  if (!entry) return null;
  return {
    direction: entry.direction === 'out' ? 'out' : 'in',
    description: String(entry.description || ''),
    amount: entry.amount === undefined || entry.amount === null ? '' : Number(entry.amount).toFixed(2),
    date: entry.date || '',
    frequency: FREQUENCIES.includes(entry.frequency) ? entry.frequency : 'once',
    endDate: entry.endDate || '',
  };
}

// The entries the server lists, whether it sends them bare or under a key,
// and the one an item came from.
export function entriesFrom(response) {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.entries) ? response.entries : [];
}

export function entryFor(entries, entryId) {
  return (entries || []).find(e => e && String(e.id ?? e.entryId) === String(entryId)) || null;
}

// What is wrong with an entry, field by field: {} when it can be sent. The
// same rules as the server's, so a reader is told before the round trip.
export function validateEntry(form = {}) {
  const e = {};
  if (form.direction !== 'in' && form.direction !== 'out') e.direction = 'Choose cash in or cash out';
  const desc = String(form.description ?? '').trim();
  if (!desc) e.description = 'Enter a description';
  else if (desc.length > DESCRIPTION_MAX) e.description = `Keep the description to ${DESCRIPTION_MAX} characters`;
  const amount = amountError(form.amount);
  if (amount) e.amount = amount;
  const date = dayError(form.date);
  if (date) e.date = date;
  const freq = form.frequency || 'once';
  if (!FREQUENCIES.includes(freq)) e.frequency = 'Choose how often it repeats';
  else if (freq !== 'once' && form.endDate) {
    const end = dayError(form.endDate, 'a valid end date');
    if (end) e.endDate = end;
    else if (isIsoDate(form.date) && form.endDate < form.date) e.endDate = 'The end date is before the first date';
  }
  return e;
}

// The body an entry is sent with. An end date only goes with a repeating
// entry: one left in the form after switching back to "Once" means nothing.
export function entryBody(form, tenantId) {
  const freq = FREQUENCIES.includes(form.frequency) ? form.frequency : 'once';
  const body = {
    direction: form.direction === 'out' ? 'out' : 'in',
    description: String(form.description || '').trim(),
    amount: toAmount(form.amount),
    date: form.date,
    frequency: freq,
  };
  if (tenantId) body.tenantId = tenantId;
  if (freq !== 'once' && form.endDate) body.endDate = form.endDate;
  return body;
}

// A change to an item from the pencil's dialog: a new date, picked or reached
// by shifting the current one some days either way, and/or a new amount.
// Returns the body for PUT /overrides (its key and only what changed) and
// any errors; a form that changes nothing is an error of its own, so Save
// does not send an empty override. Unlike an entry, an item may be expected
// to settle for nothing, so a nil amount is allowed, as the server allows it.
export function overrideFromForm(item, form = {}) {
  const errors = {};
  const body = { key: item?.key };
  const current = item?.date || '';
  let date = '';
  if (form.how === 'shift') {
    const s = String(form.shift ?? '').trim();
    if (s !== '') {
      if (!/^[+-]?\d+$/.test(s)) errors.shift = 'Enter a whole number of days';
      else if (Math.abs(Number(s)) > SHIFT_MAX) errors.shift = `Shift by at most ${SHIFT_MAX} days`;
      else if (!isIsoDate(current)) errors.shift = 'This item has no date to shift';
      else if (Number(s) !== 0) date = addDays(current, Number(s));
      if (date && dayError(date)) { errors.shift = dayError(date, 'a shift that lands'); date = ''; }
    }
  } else if (form.date) {
    const err = dayError(form.date, 'a valid date');
    if (err) errors.date = err;
    else if (form.date !== current) date = form.date;
  }
  if (date) body.date = date;

  const a = String(form.amount ?? '').trim();
  if (a !== '') {
    const err = amountError(a, { allowZero: true });
    if (err) errors.amount = err;
    else if (cents(toAmount(a)) !== cents(item?.amount)) body.amount = toAmount(a);
  }
  if (!Object.keys(errors).length && body.date === undefined && body.amount === undefined) {
    errors.form = 'Nothing has changed';
  }
  return { body, errors };
}

// The bank options as the form edits them: whether each account counts, and
// its opening adjustment and overdraft limit as typed. Foreign-currency
// accounts are not in it — they are shown, but the forecast is in the base
// currency and does not count them.
export function bankOptionsForm(accounts) {
  const out = {};
  for (const a of accounts || []) {
    if (!a?.accountId || a.foreign) continue;
    out[a.accountId] = {
      included: a.included !== false,
      openingAdjustment: cents(a.openingAdjustment) ? num(a.openingAdjustment).toFixed(2) : '',
      overdraft: cents(a.overdraft) ? num(a.overdraft).toFixed(2) : '',
    };
  }
  return out;
}

// The body for PUT /bank-options, and the errors by account. A blank figure
// is nil. An adjustment may take money off as well as add it; a limit is
// how far below zero the bank lets the account go, so it is never negative.
export function bankOptionsBody(accounts, form, tenantId) {
  const errors = {};
  const out = {};
  for (const a of accounts || []) {
    if (!a?.accountId || a.foreign) continue;
    const f = form?.[a.accountId] || {};
    const err = {};
    const adj = cleanAmount(f.openingAdjustment);
    const od = cleanAmount(f.overdraft);
    if (adj) { const m = amountError(adj, { allowNegative: true, allowZero: true }); if (m) err.openingAdjustment = m; }
    if (od)  { const m = amountError(od, { allowZero: true }); if (m) err.overdraft = m; }
    if (Object.keys(err).length) errors[a.accountId] = err;
    out[a.accountId] = { included: !!f.included, openingAdjustment: adj ? toAmount(adj) : 0, overdraft: od ? toAmount(od) : 0 };
  }
  const body = { accounts: out };
  if (tenantId) body.tenantId = tenantId;
  return { body, errors };
}

// An account's balance as the dialog shows it: null when the bank could not
// be read (or the server sent none for it), which the dialog says is
// unavailable rather than showing nil.
export function accountBalance(account, bank) {
  return bank?.available === false ? null : known(account?.balance);
}

// The balance the forecast would start from with the options as typed: each
// counted account's Xero balance plus its adjustment. Shown in the dialog so
// the effect of a change is seen before it is saved. Null when a counted
// account's balance is not known: a sum without it is no one's balance.
export function bankStart(accounts, form, bank) {
  let total = 0;
  for (const a of accounts || []) {
    const f = form?.[a?.accountId];
    if (!f || a.foreign || !f.included) continue;
    const balance = accountBalance(a, bank);
    if (balance === null) return null;
    total += balance + (amountError(f.openingAdjustment, { allowNegative: true, allowZero: true }) ? 0 : toAmount(f.openingAdjustment));
  }
  return Math.round(total * 100) / 100;
}

// What the dialog says above the accounts, or '' when it has nothing to say.
// A read that failed is not an organisation with no bank accounts: it says
// which of Xero's reads failed, and that the options wait for it.
export function bankOptionsNotice(bank) {
  const accounts = Array.isArray(bank?.accounts) ? bank.accounts : [];
  if (bank?.available === false) {
    const reason = bank.unavailableReason;
    if (accounts.length) {
      return reason === 'accounts' ? `${BANK_UNAVAILABLE.accounts}.` : `${BANK_UNAVAILABLE[reason] || BANK_UNAVAILABLE_ANY}, so the balances are unavailable.`;
    }
    if (reason === 'accounts') return 'Xero\'s list of bank accounts could not be read just now. Bank options can be set once it can.';
    if (reason === 'summary') return 'The bank accounts could not be read from Xero just now: its Bank Summary did not answer. Bank options can be set once they can.';
    return 'The bank accounts could not be read from Xero just now. Bank options can be set once they can.';
  }
  return accounts.length ? '' : 'Xero returned no bank accounts.';
}

// ── A day's items ───────────────────────────────────────────────────────────

const sideFirst = (a, b) => (a.direction === b.direction ? mag(b.amount) - mag(a.amount) : a.direction === 'in' ? -1 : 1);

// The items behind one day of the chart, or behind its Overdue pair when
// `date` is 'overdue': cash in before cash out, largest first. Excluded items
// are left out, as the chart leaves them out. An overdue item belongs to the
// Overdue pair whatever date it carries, so it is never counted twice. A day
// before today lists what actually moved on it, each marked as actual: those
// are records in Xero, not items of the forecast to move or leave out.
export function dayItems(payload, date) {
  if (isActualDay(payload, date)) {
    return (Array.isArray(payload?.actualItems) ? payload.actualItems : [])
      .filter(i => i && i.date === date)
      .map(i => ({ ...i, actual: true, dateBasis: 'actual' }))
      .sort(sideFirst);
  }
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items
    .filter(i => i && !i.excluded && (date === 'overdue' ? i.overdue : !i.overdue && i.date === date))
    .sort(sideFirst);
}

// A day as the tooltip and the day panel head it: its title, the day's cash
// in, out and net (the server's figures, which are what the bar is drawn
// from), the balance at the end of it, and up to `limit` of its items with
// how many more there are.
export function daySummary(payload, date, limit = 5) {
  const all = dayItems(payload, date);
  const actual = isActualDay(payload, date);
  let cin, cout, net, balance = null;
  if (actual) {
    const a = actualWindow(payload).rows.find(x => x.date === date);
    cin = a.in; cout = a.out; net = a.net; balance = a.balance;
  } else if (date === 'overdue') {
    const od = payload?.tiles?.overdue || {};
    cin = mag(od.in); cout = mag(od.out); net = od.net === undefined || od.net === null ? cin - cout : num(od.net);
  } else {
    const s = (payload?.series || []).find(x => x.date === date);
    if (s) {
      cin = mag(s.in); cout = mag(s.out); net = s.net === undefined || s.net === null ? cin - cout : num(s.net);
      balance = bankKnown(payload) ? known(s.balance) : null;
    } else {
      cin = sumOf(all.filter(i => i.direction === 'in'));
      cout = sumOf(all.filter(i => i.direction === 'out'));
      net = cin - cout;
    }
  }
  const title = date === 'overdue' ? 'Overdue'
    : date === payload?.today ? `Today, ${weekdayDay(date)}`
    : `${weekdayDay(date)} ${parts(date)?.y || ''}`.trim() + (actual ? ' · Actual' : '');
  return { date, title, actual, in: cin, out: cout, net, balance, items: all.slice(0, limit), more: Math.max(0, all.length - limit), count: all.length };
}

// ── The table and the calendar ──────────────────────────────────────────────

// The table view: the days before today as they happened, each marked as
// actual, then the Overdue row (it has no balance — it is not a day), then a
// row a day ahead, and the window's totals with the balance it ends on. The
// totals and `days` (the rows they add up) are today and the days ahead only:
// what moved before today is not part of what the window projects. Xero's
// "30 days" is today and the thirty after it, so the heading's 30 is `ahead`
// and the foot (`totalLabel`) says "today + 30 days" over the 31 rows it
// adds, where it said "31 days" under a heading of 30. `actualNote` says when
// the days before today could not be read, `balanceNote` when today's
// balance could not, and the balance column is blank.
export function tableRows(payload, days) {
  const { series, days: ahead } = windowOf(payload, days);
  const past = actualWindow(payload);
  const bank = bankKnown(payload);
  const od = payload?.tiles?.overdue || {};
  const oin = mag(od.in), oout = mag(od.out);
  const rows = past.rows.map(a => ({ key: `actual:${a.date}`, ...a, label: weekdayDay(a.date) }));
  rows.push({ key: 'overdue', date: 'overdue', label: 'Overdue', in: oin, out: oout, net: od.net === undefined || od.net === null ? oin - oout : num(od.net), balance: null });
  const daysRows = [];
  for (const s of series) {
    const cin = mag(s.in), cout = mag(s.out);
    daysRows.push({ key: s.date, date: s.date, label: weekdayDay(s.date), today: s.date === payload?.today,
                    in: cin, out: cout, net: s.net === undefined || s.net === null ? cin - cout : num(s.net),
                    balance: bank ? known(s.balance) : null });
  }
  return {
    rows: [...rows, ...daysRows],
    actualNote: past.note,
    balanceNote: bank ? '' : `Bank balance unavailable: ${bankUnavailableText(payload)}.`,
    days: daysRows.length,
    ahead,
    totalLabel: !daysRows.length ? 'Total' : ahead ? `Total, today + ${ahead} day${ahead === 1 ? '' : 's'}` : 'Total, today',
    total: {
      in: daysRows.reduce((s, r) => s + r.in, 0),
      out: daysRows.reduce((s, r) => s + r.out, 0),
      net: daysRows.reduce((s, r) => s + r.net, 0),
      balance: daysRows.length ? daysRows[daysRows.length - 1].balance : null,
    },
  };
}

export function weekdayLabels() {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
}

// The calendar view: a month grid for each month the window and the days
// before today touch, weeks from Monday. Every day of those months is a cell,
// so the grid reads as a calendar; the days outside both (before the first
// actual day, after the window's end) carry no figures. A day before today
// carries what actually moved and is marked `actual`. A blank cell pads the
// first and last week.
export function calendarMonths(payload, days) {
  const { series, start: from, end } = windowOf(payload, days);
  if (!series.length || !isIsoDate(from) || !isIsoDate(end)) return [];
  const past = actualWindow(payload).rows;
  const bank = bankKnown(payload);
  const byDate = new Map([...past, ...series].map(s => [s.date, s]));
  const today = payload?.today || from;
  const start = past.length && past[0].date < from ? past[0].date : from;
  const a = parts(start), b = parts(end);
  const months = [];
  for (let idx = a.y * 12 + a.m - 1; idx <= b.y * 12 + b.m - 1; idx++) {
    const y = Math.floor(idx / 12), m = (idx % 12) + 1;
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
    const cells = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= length; d++) {
      const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const s = byDate.get(date);
      const inWindow = !!s;
      const cin = inWindow ? mag(s.in) : 0, cout = inWindow ? mag(s.out) : 0;
      cells.push({
        date, day: d, inWindow, today: date === today, actual: !!s?.actual,
        in: cin, out: cout, net: inWindow ? (s.net === undefined || s.net === null ? cin - cout : num(s.net)) : 0,
        balance: inWindow && bank ? known(s.balance) : null,
      });
    }
    while (cells.length % 7) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    months.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTH_FULL[m - 1]} ${y}`, weeks });
  }
  return months;
}
