const fs   = require('fs');
const path = require('path');

// Live updates on the Dashboard, on the screen side. There is no React test
// setup in this project, so this follows xero-check-ui.test.js: the decisions
// — did the server's change stamp move, was a report read before it moved,
// what the status line and the banner say — are plain functions in live.js, a
// file with no imports, loaded whole and run here; the wiring (what a change
// refetches, that it does so quietly and without force, that Refresh re-reads
// the version) is checked in the source.
const UI = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');
const HELPERS = 'pages/xero-insights/live.js';

function loadHelpers() {
  const src = read(HELPERS);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const h = loadHelpers();

const T1 = '2026-10-10T02:02:00.000Z';
const T2 = '2026-10-10T02:04:00.000Z';

describe('did the change stamp move', () => {
  test('the first read never counts, whatever it brings', () => {
    expect(h.hasChanged(undefined, T1)).toBe(false);
    expect(h.hasChanged(undefined, null)).toBe(false);
  });

  test('a stamp where the server had seen no change yet is the first change', () => {
    expect(h.hasChanged(null, T1)).toBe(true);
    expect(h.hasChanged(null, null)).toBe(false);
  });

  test('only a later stamp counts: the same, an earlier or an unreadable one does not', () => {
    expect(h.hasChanged(T1, T2)).toBe(true);
    expect(h.hasChanged(T1, T1)).toBe(false);
    expect(h.hasChanged(T2, T1)).toBe(false);
    expect(h.hasChanged(T1, 'not a date')).toBe(false);
    expect(h.hasChanged(T1, null)).toBe(false);
  });
});

describe('must a tab ask again when opened', () => {
  test('a report read before the change is stale, one read after is not', () => {
    expect(h.shouldRefetchTab(T1, T2)).toBe(true);
    expect(h.shouldRefetchTab(T2, T1)).toBe(false);
    expect(h.shouldRefetchTab(T2, T2)).toBe(false);
  });

  test('reports carry the cache stamp as milliseconds, which compares the same way', () => {
    expect(h.shouldRefetchTab(Date.parse(T1), T2)).toBe(true);
    expect(h.shouldRefetchTab(Date.parse(T2), T1)).toBe(false);
  });

  test('nothing to compare is not stale: never loaded, or no change seen', () => {
    expect(h.shouldRefetchTab(undefined, T2)).toBe(false);
    expect(h.shouldRefetchTab(null, T2)).toBe(false);
    expect(h.shouldRefetchTab(T1, null)).toBe(false);
    expect(h.shouldRefetchTab(T1, undefined)).toBe(false);
  });
});

describe('the oldest read on screen', () => {
  test('is the earliest of the known stamps, in either form', () => {
    expect(h.oldestRead([Date.parse(T2), T1, undefined, null, 'x'])).toBe(Date.parse(T1));
    expect(h.oldestRead([Date.parse(T2)])).toBe(Date.parse(T2));
  });

  test('and null when none is known', () => {
    expect(h.oldestRead([undefined, null])).toBe(null);
    expect(h.oldestRead([])).toBe(null);
    expect(h.oldestRead(undefined)).toBe(null);
  });
});

describe('the status line', () => {
  // A clock time in UTC, standing in for formatTime in the reader's timezone.
  const clock = t => new Date(t).toISOString().slice(11, 16);

  test('says when Xero was read for the figures and when the server last asked it', () => {
    expect(h.liveLabel({ fetchedAt: T1, checkedAt: T2, live: true, liveReason: null }, clock)).toEqual({
      asOf: 'Xero data as of 02:02', checked: '· checked 02:04', off: null, reason: null, reconnect: false,
    });
  });

  test('before the version is read, and with the cache stamp as a number', () => {
    expect(h.liveLabel({ fetchedAt: Date.parse(T1) }, clock)).toEqual({
      asOf: 'Xero data as of 02:02', checked: null, off: null, reason: null, reconnect: false,
    });
    expect(h.liveLabel({}, clock).asOf).toBe('Xero data');
    expect(h.liveLabel(undefined, clock).asOf).toBe('Xero data');
  });

  test('says live updates are off, with the reason, and offers Setup only when a reconnect cures it', () => {
    const reconnect = h.liveLabel({ fetchedAt: T1, checkedAt: null, live: false, liveReason: 'Reconnect Xero once to allow live updates' }, clock);
    expect(reconnect).toEqual({
      asOf: 'Xero data as of 02:02', checked: null, off: '· live updates off',
      reason: 'Reconnect Xero once to allow live updates', reconnect: true,
    });
    for (const reason of ['Custom Connections are not watched', 'daily Xero allowance low']) {
      const l = h.liveLabel({ fetchedAt: T1, checkedAt: T2, live: false, liveReason: reason }, clock);
      expect(l.off).toBe('· live updates off');
      expect(l.checked).toBe('· checked 02:04');
      expect(l.reason).toBe(reason);
      expect(l.reconnect).toBe(false);
    }
  });

  test('a company the detector has not reached yet is pending, not off', () => {
    const l = h.liveLabel({ fetchedAt: T1, checkedAt: null, live: false, liveReason: 'Not checked yet' }, clock);
    expect(l.off).toBe(null);
    expect(l.checked).toBe('· first check pending');
    expect(l.reason).toBe(null);
    // Once a check has happened the same reason would be a real "off".
    const later = h.liveLabel({ fetchedAt: T1, checkedAt: T2, live: false, liveReason: 'Not checked yet' }, clock);
    expect(later.off).toBe('· live updates off');
  });

  test('a reason is only a reason while live updates are off', () => {
    const l = h.liveLabel({ fetchedAt: T1, live: true, liveReason: 'Reconnect Xero once to allow live updates' }, clock);
    expect(l.off).toBe(null);
    expect(l.reason).toBe(null);
    expect(l.reconnect).toBe(false);
  });
});

describe('the banner title for the scopes a connection is missing', () => {
  test.each([
    [['accounting.journals.read'], 'Reconnect Xero once to turn on live updates'],
    [['accounting.attachments', 'accounting.journals.read'], 'Reconnect Xero once to allow attachments and live updates'],
    [['accounting.journals.read', 'accounting.attachments', 'accounting.budgets.read'], 'Reconnect Xero once to allow attachments and live updates'],
    [['accounting.attachments'], 'Reconnect Xero to allow attachments'],
    // The Balance Sheet needs two report scopes, asked for together, so
    // either missing is the one thing the banner names.
    [['accounting.reports.balancesheet.read'], 'Reconnect Xero once to add the Balance Sheet'],
    [['accounting.reports.trialbalance.read'], 'Reconnect Xero once to add the Balance Sheet'],
    [['accounting.reports.balancesheet.read', 'accounting.reports.trialbalance.read'], 'Reconnect Xero once to add the Balance Sheet'],
    [['accounting.attachments', 'accounting.journals.read', 'accounting.reports.balancesheet.read'], 'Reconnect Xero once to allow attachments, live updates and the Balance Sheet'],
    [['accounting.reports.trialbalance.read', 'accounting.attachments'], 'Reconnect Xero once to allow attachments and the Balance Sheet'],
    [['accounting.journals.read', 'accounting.reports.balancesheet.read'], 'Reconnect Xero once to allow live updates and the Balance Sheet'],
    [['accounting.budgets.read'], null],
    [[], null],
    [undefined, null],
  ])('%j → %s', (missing, title) => expect(h.bannerTitle(missing)).toBe(title));

  test('the detail names what each scope costs meanwhile, and how many permissions a reconnect asks for', () => {
    expect(h.bannerDetail(['accounting.journals.read']))
      .toBe('The Dashboard cannot see when Xero changes, so its figures wait for a Refresh. Reconnecting asks Xero for that permission.');
    expect(h.bannerDetail(['accounting.attachments']))
      .toBe('Bills and claims are reaching Xero without their PDF or receipt photo. Reconnecting asks Xero for that permission.');
    expect(h.bannerDetail(['accounting.attachments', 'accounting.journals.read']))
      .toBe('Bills and claims are reaching Xero without their PDF or receipt photo. '
          + 'The Dashboard cannot see when Xero changes, so its figures wait for a Refresh. Reconnecting asks Xero for those permissions.');
    expect(h.bannerDetail(['accounting.reports.balancesheet.read']))
      .toBe('The Balance Sheet tab cannot be read until then. Reconnecting asks Xero for that permission.');
    expect(h.bannerDetail(['accounting.journals.read', 'accounting.reports.trialbalance.read']))
      .toBe('The Dashboard cannot see when Xero changes, so its figures wait for a Refresh. '
          + 'The Balance Sheet tab cannot be read until then. Reconnecting asks Xero for those permissions.');
    expect(h.bannerDetail([])).toBe(null);
  });
});

describe('the page is wired to these helpers', () => {
  const page = read('pages/XeroInsights.jsx');
  const bits = read('pages/xero-insights/bits.jsx');

  test('it asks the version route every minute while in view, per organisation, and no longer ticks every 15 s', () => {
    expect(page).toMatch(/api\.get\(`\/xero-reports\/version\?\$\{params\.toString\(\)\}`\)/);
    expect(page).toMatch(/const VERSION_EVERY_MS = 60 \* 1000;/);
    expect(page).toMatch(/useVisiblePolling\(\(\) => \{ if \(activeTenantId && data\?\.connected\) return fetchVersion\(\); \}, VERSION_EVERY_MS\);/);
    expect(page).not.toMatch(/forceTick|, 15000\)|formatRelative|Synced \{/);
  });

  test('the first read for an organisation records the stamp, and a switch starts over', () => {
    expect(page).toMatch(/const seenChangedAt = useRef\(undefined\);/);
    expect(page).toMatch(/if \(!adopt && hasChanged\(prev, v\.changedAt\)\) setPendingChange\(v\.changedAt\);/);
    // The reset sits in the effect that reads the version for the organisation.
    expect(page).toMatch(/seenChangedAt\.current = undefined;\s+reasked\.current = \{\};\s+setVersion\(null\);[\s\S]*?fetchVersion\(\);\s+\}, \[activeTenantId\]\);/);
  });

  test('a change refetches what is on screen, quietly and without force', () => {
    const refetch = page.slice(page.indexOf('async function refetchShown()'), page.indexOf('function staleOnOpen('));
    expect(refetch).toMatch(/fetchSummary\(\{ quiet: true \}\)/);
    expect(refetch).toMatch(/if \(PERF_TABS\.includes\(tab\)\)\s+jobs\.push\(fetchPerf\(\{ quiet: true \}\)\);/);
    expect(refetch).toMatch(/if \(tab === 'cashflow'\)\s+jobs\.push\(fetchCashflow\(\{ quiet: true \}\)\);/);
    expect(refetch).toMatch(/if \(tab === 'budget' \|\| tab === 'variance'\)\s+jobs\.push\(fetchBudget\(\{ quiet: true \}\)\);/);
    expect(refetch).toMatch(/if \(tab === 'banking'\)\s+jobs\.push\(fetchBanking\(\{ quiet: true \}\)\);/);
    expect(refetch).toMatch(/if \(ageingSide\)\s+jobs\.push\(fetchAgeing\(ageingSide, \{ quiet: true \}\)\);/);
    expect(refetch).not.toMatch(/force/);
    // The notice waits for all of it to land.
    expect(refetch).toMatch(/await Promise\.allSettled\(jobs\);\s+setUpdatedAt\(Date\.now\(\)\);/);
    // Acted on from an effect, so the tab it reads is the one open now.
    expect(page).toMatch(/if \(!pendingChange\) return;\s+setPendingChange\(null\);\s+refetchShown\(\);/);
  });

  test('a quiet fetch never puts a loading placeholder over the figures, and keeps them on a failure', () => {
    for (const set of ['setPerf', 'setBudget', 'setCashflow', 'setBanking', 'setAgeing']) {
      expect(page).toMatch(new RegExp(`if \\(!opts\\.quiet\\) ${set}\\(`));
    }
    expect(page).toMatch(/if \(fresh\(\) && !opts\.quiet\) setError\(/);
    expect(page).toMatch(/if \(opts\.quiet\) setPerf\(s => \(s\.status === 'done' \? s : \{ \.\.\.s, status: 'done' \}\)\);/);
    expect(page).toMatch(/if \(opts\.quiet\) setAgeing\(s => \(s\[side\]\.status === 'done' \? s : /);
    // The commentary is not regenerated on every change.
    expect(page).toMatch(/if \(opts\.quiet\) return req;\s+\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(opts\.figuresOnly\) return;/);
  });

  test('a tab opened after a change asks again for a report read before it, once per change', () => {
    expect(page).toMatch(/else if \(staleOnOpen\('perf', perf\.data\?\.fetchedAt\)\) fetchPerf\(\{ quiet: true \}\);/);
    expect(page).toMatch(/else if \(staleOnOpen\('cashflow', cashflow\.data\?\.fetchedAt\)\) fetchCashflow\(\{ quiet: true \}\);/);
    expect(page).toMatch(/else if \(staleOnOpen\('budget', budget\.data\?\.fetchedAt\)\) fetchBudget\(\{ quiet: true \}\);/);
    expect(page).toMatch(/else if \(staleOnOpen\('banking', banking\.fetchedAt\)\) fetchBanking\(\{ quiet: true \}\);/);
    expect(page).toMatch(/else if \(staleOnOpen\(`ageing:\$\{ageingSide\}`, s\.data\?\.fetchedAt\)\) fetchAgeing\(ageingSide, \{ quiet: true \}\);/);
    expect(page).toMatch(/if \(!shouldRefetchTab\(fetchedAt, changedAt\) \|\| reasked\.current\[key\] === changedAt\) return false;/);
    // The bank account list keeps its read's stamp, which the list alone did not carry.
    expect(page).toMatch(/fetchedAt: d\.fetchedAt \}\)/);
  });

  test('Refresh still forces, then re-reads the version without acting on it', () => {
    expect(page).toMatch(/fetchSummary\(\{ force: true \}\)\.then\(\(\) => fetchVersion\(\{ adopt: true \}\)\);/);
    expect(page).toMatch(/if \(PERF_TABS\.includes\(tab\)\) fetchPerf\(\{ force: true \}\);/);
  });

  test('the status line is worded by liveLabel in the reader\'s timezone, from the oldest read on screen', () => {
    expect(page).toMatch(/import \{ hasChanged, shouldRefetchTab, oldestRead, liveLabel \} from '\.\/xero-insights\/live';/);
    expect(page).toMatch(/fetchedAt: oldestRead\(shownReads\(\)\), checkedAt: version\?\.checkedAt, live: version\?\.live, liveReason: version\?\.liveReason/);
    expect(page).toMatch(/t => formatTime\(t, user\?\.timezone\)/);
    expect(page).toMatch(/<LiveStatus label=\{status\} updated=\{!!updatedAt\} onSetup=\{\(\) => navigate\('\/setup'\)\} \/>/);
    expect(page).toMatch(/const UPDATED_NOTICE_MS = 8000;/);
  });

  test('the status line shows every piece, the way to Setup, and the notice as a status region', () => {
    const live = bits.slice(bits.indexOf('export function LiveStatus('));
    expect(live).toMatch(/\{label\.asOf\}/);
    expect(live).toMatch(/\{label\.checked && /);
    expect(live).toMatch(/title=\{label\.reason \|\| undefined\}/);
    expect(live).toMatch(/\{label\.reconnect && /);
    expect(live).toMatch(/href="\/setup"/);
    expect(live).toMatch(/role="status"[^>]*>\s*Updated just now from Xero/);
  });
});

describe('the banner is wired to the same wording', () => {
  const banner = read('components/layout/XeroConnectionBanner.jsx');

  test('it takes its title and detail for a missing scope from live.js, and keeps its dismiss and Setup link', () => {
    expect(banner).toMatch(/import \{ bannerTitle, bannerDetail \} from '\.\.\/\.\.\/pages\/xero-insights\/live';/);
    expect(banner).toMatch(/const scoped = bannerTitle\(missing\);/);
    expect(banner).toMatch(/title: scoped, detail: c\.reason \|\| bannerDetail\(missing\)/);
    // The same key as before: dismissing it hides this set of missing scopes.
    expect(banner).toMatch(/key: `scopes:\$\{\[\.\.\.missing\]\.sort\(\)\.join\(','\)\}`, title: scoped/);
    expect(banner).toMatch(/<Link to="\/setup" className="btn btn-outline btn-sm">Open Setup<\/Link>/);
    expect(banner).toMatch(/sessionStorage\.setItem\(DISMISSED_KEY, problem\.key\)/);
    // A connection Xero no longer accepts still comes first.
    expect(banner.indexOf('if (c.needsReconnect)')).toBeLessThan(banner.indexOf('const scoped = bannerTitle(missing);'));
  });
});
