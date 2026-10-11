// Setup's Xero connect controls (ui/src/pages/setup/connect.js). Connect used
// to ask for every optional permission, and Xero answers an app it will not
// give one to on its own "invalid_scope" page, which never comes back — so
// Connect looked broken. Each optional permission is now a box, set from what
// /api/xero/connection says became of it, and the banner only asks for a
// reconnect when one would work. The page cannot be rendered on this machine,
// so the rules live in a plain module and are run here.
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'ui', 'src', 'pages', 'setup', 'connect.js');

function load() {
  const src = fs.readFileSync(SRC, 'utf8');
  if (/^import /m.test(src)) throw new Error('connect.js now imports something; this harness runs it standalone');
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const c = load();

const JOURNALS = 'accounting.journals.read';
const BS = 'accounting.reports.balancesheet.read';
const TB = 'accounting.reports.trialbalance.read';
const optional = (live, balance) => ({
  live:    { label: 'Live updates',  scopes: [JOURNALS], status: live },
  balance: { label: 'Balance Sheet', scopes: [BS, TB],   status: balance },
});

describe('each box, from what became of its permission', () => {
  test('granted and missing start ticked; granted says so', () => {
    expect(c.boxState(optional('granted', 'missing'), 'live')).toMatchObject({ checked: true, disabled: false, note: 'granted' });
    expect(c.boxState(optional('granted', 'missing'), 'balance')).toMatchObject({ checked: true, disabled: false, note: null });
  });

  test('declined starts unticked: a page load must not undo the person\'s choice', () => {
    expect(c.boxState(optional('declined', 'missing'), 'live')).toMatchObject({ checked: false, disabled: false });
  });

  test('refused is unticked, locked, and says Xero does not allow it', () => {
    expect(c.boxState(optional('refused', 'missing'), 'live')).toEqual({
      checked: false, disabled: true, note: 'Xero does not allow this app this permission', status: 'refused',
    });
  });

  // Asking for a permission Xero refuses is the failure the boxes exist to
  // prevent, so one nobody has settled is tried only on purpose.
  test('unknown starts unticked, with a note saying it may be tried', () => {
    const box = c.boxState(optional('unknown', 'missing'), 'live');
    expect(box).toMatchObject({ checked: false, disabled: false, status: 'unknown' });
    expect(box.note).toMatch(/tick to try/);
  });

  test('an older server, a missing group or a status this code does not know reads as unknown', () => {
    expect(c.optionalStatus(null, 'live')).toBe('unknown');
    expect(c.optionalStatus({}, 'balance')).toBe('unknown');
    expect(c.optionalStatus({ live: { status: 'something-new' } }, 'live')).toBe('unknown');
  });

  test('the starting ticks for both boxes', () => {
    expect(c.defaultBoxes(optional('refused', 'missing'))).toEqual({ live: false, balance: true });
    expect(c.defaultBoxes(null)).toEqual({ live: false, balance: false });
  });
});

describe('what Connect asks the server for', () => {
  test('the ticked groups, in the boxes\' own order, or none at all', () => {
    expect(c.extrasParam({ balance: true, live: true })).toBe('live,balance');
    expect(c.extrasParam({ live: false, balance: true })).toBe('balance');
    expect(c.extrasParam({ live: false, balance: false })).toBe('');
    expect(c.extrasParam(null)).toBe('');
  });

  test('the boxes are the two groups the server knows', () => {
    expect(c.optionalBoxes().map(b => b.key)).toEqual(['live', 'balance']);
  });
});

describe('which missing permissions the banner may still ask a reconnect over', () => {
  const missing = ['accounting.attachments', JOURNALS, BS, TB];

  test('only a group Xero is known to allow and never asked for; attachments always', () => {
    expect(c.bannerGroups(optional('missing', 'missing'), missing)).toEqual(missing);
    expect(c.bannerGroups(optional('refused', 'missing'), missing)).toEqual(['accounting.attachments', BS, TB]);
    expect(c.bannerGroups(optional('declined', 'unknown'), missing)).toEqual(['accounting.attachments']);
    expect(c.bannerGroups(optional('unknown', 'refused'), missing)).toEqual(['accounting.attachments']);
  });

  test('an older server with no `optional` keeps every missing scope, as the banner worked before', () => {
    expect(c.bannerGroups(undefined, missing)).toEqual(missing);
    expect(c.bannerGroups(null, [])).toEqual([]);
  });

  test('the server\'s own scope list for a group wins over the copy here', () => {
    const renamed = { live: { scopes: ['accounting.journals.v2.read'], status: 'refused' }, balance: { scopes: [BS, TB], status: 'missing' } };
    expect(c.bannerGroups(renamed, ['accounting.journals.v2.read', JOURNALS])).toEqual([JOURNALS]);
  });
});
