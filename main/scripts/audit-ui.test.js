const fs   = require('fs');
const path = require('path');

// The audit trail on screen: the review page's History and the Admin page's
// Activity tab. There is no React test setup in this project (see
// invoice-tabs.test.js), so ui/src/utils/audit.js, which imports nothing, is
// run here whole, and the pages are checked for how they use it.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function loadAudit() {
  const src = read('utils/audit.js');
  if (/^import /m.test(src)) throw new Error('audit.js now imports something; this harness runs it standalone');
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

describe('who acted (actorLabel)', () => {
  const { actorLabel } = loadAudit();
  const me = { id: 'u1', email: 'me@test.com' };

  test('the person looking is "You"; an admin is named; background work is the System', () => {
    expect(actorLabel({ actorType: 'user', actorId: 'u1', actorEmail: 'me@test.com' }, me)).toBe('You');
    expect(actorLabel({ actorType: 'admin', actorId: 'a1', actorEmail: 'boss@test.com' }, me)).toBe('Admin boss@test.com');
    expect(actorLabel({ actorType: 'system', actorId: null }, me)).toBe('System');
  });

  test('an admin reading someone else\'s record sees the owner by email, and their own actions as theirs', () => {
    const adminMe = { id: 'a1' };
    expect(actorLabel({ actorType: 'user', actorId: 'u1', actorEmail: 'owner@test.com' }, adminMe)).toBe('owner@test.com');
    expect(actorLabel({ actorType: 'admin', actorId: 'a1', actorEmail: 'boss@test.com' }, adminMe)).toBe('You (as admin)');
    expect(actorLabel({ actorType: 'user', actorId: 'u9' }, adminMe)).toBe('The account owner');
  });
});

describe('the Activity query (activityQuery)', () => {
  const { activityQuery } = loadAudit();

  test('only the filters set, and the page cursor', () => {
    expect(activityQuery({ userId: '', action: '', from: '', to: '' })).toBe('');
    expect(activityQuery({ userId: 'u1', action: 'user.role' }, 42)).toBe('userId=u1&action=user.role&before=42');
  });

  test('dates are whole local days: from its start, to the start of the day after', () => {
    const qs = new URLSearchParams(activityQuery({ from: '2026-09-01', to: '2026-09-30' }));
    expect(new Date(qs.get('from')).getTime()).toBe(new Date('2026-09-01T00:00').getTime());
    expect(new Date(qs.get('to')).getTime()).toBe(new Date('2026-10-01T00:00').getTime());
    expect(activityQuery({ from: 'not a date' })).toBe('');
  });
});

describe('the pages', () => {
  test('the review page shows the History, refreshed when the record changes', () => {
    const review = read('pages/InvoiceReview.jsx');
    expect(review).toContain("import HistoryCard from './invoice-review/HistoryCard'");
    expect(review).toMatch(/<HistoryCard id=\{id\} user=\{user\} isMobile=\{isMobile\}\s+refreshKey=/);
  });

  test('History is closed on a phone, fetched only when open, and pages with before', () => {
    const card = read('pages/invoice-review/HistoryCard.jsx');
    expect(card).toContain('useState(!isMobile)');
    expect(card).toMatch(/if \(open\) load\(\)/);
    expect(card).toContain('/invoices/${id}/events');
    expect(card).toContain('?before=${before}');
    expect(card).toContain('formatDateTime(e.at, user?.timezone)');
    expect(card).toContain('actorLabel(e, user)');
  });

  test('Admin has an Activity tab that lists the admin trail', () => {
    const admin = read('pages/Admin.jsx');
    expect(admin).toMatch(/\{ key: 'activity',\s+label: '[^']*Activity' \}/);
    expect(admin).toContain("{tab === 'activity'   && <ActivityPanel timezone={me?.timezone} />}");
    const panel = read('pages/admin/ActivityPanel.jsx');
    expect(panel).toContain('/admin/events');
    expect(panel).toContain('activityQuery(f, before)');
  });
});
