const fs   = require('fs');
const path = require('path');

// Setup's connected-companies rows (ui/src/pages/setup/company-status.js).
// Every company showed "● Live" whatever the connection's state, so one Xero
// had stopped accepting still looked live while nothing could be sent, and a
// failed read of the companies showed nothing at all. There is no React test
// setup in this project; the module imports nothing, so it is run here whole.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  if (/^import /m.test(src)) throw new Error(`${rel} now imports something; this harness runs it standalone`);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}

test("Live only while the connection works; Needs reconnect, Not connected and Couldn't check otherwise", () => {
  const c = load('pages/setup/company-status.js');
  const live = { connected: true, needsReconnect: false, reason: null };

  expect(c.companyBadge(live, false).text).toBe('● Live');
  // The last answer stands through a failed re-check.
  expect(c.companyBadge(live, true).text).toBe('● Live');
  expect(c.companyBadge({ connected: false, needsReconnect: true, reason: 'Xero refused the saved sign-in' }, false))
    .toMatchObject({ text: 'Needs reconnect', title: 'Xero refused the saved sign-in' });
  expect(c.companyBadge({ connected: true, needsReconnect: true }, false).text).toBe('Needs reconnect');
  expect(c.companyBadge({ connected: false, needsReconnect: false }, false).text).toBe('Needs reconnect');
  expect(c.companyBadge(null, true).text).toBe('Couldn’t check');
  expect(c.companyBadge(null, false).text).toBe('Checking…');

  expect(c.companiesView(null, false)).toBe('loading');
  expect(c.companiesView([], false)).toBe('none');
  expect(c.companiesView([], true)).toBe('failed');
  expect(c.companiesView([{ tenantId: 't' }], false)).toBe('list');

  const page = read('pages/Setup.jsx');
  expect(page).toContain('companyBadge(connection, connectionFailed)');
  expect(page).toContain('>Not connected<');
  expect(page).toContain('>Couldn’t check<');
  expect(page).not.toContain('<span className="badge badge-green">● Live</span>');
});
