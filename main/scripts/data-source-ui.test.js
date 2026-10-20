const fs   = require('fs');
const path = require('path');

// An admin's choice of data source, on the screen side: their own Xero data,
// or the Demo Company's sample data a demo account shows, switched back and
// forth from Setup's Xero card or the Dashboard (PUT /api/setup/data-source).
// As in demo-ui.test.js, there is no React test setup in this project, so
// the decisions — who is offered the choice, which source an account is on,
// what is asked before a switch — are plain functions in a file with no
// imports, loaded whole and run here; the wiring is checked in the source.
const UI   = path.join(__dirname, '../../ui/src');
const read = rel => fs.readFileSync(path.join(UI, rel), 'utf8');

function load(rel) {
  const src = read(rel);
  // The whole point of the file having no imports: it runs as it is.
  expect(src).not.toMatch(/^import /m);
  const names = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map(m => m[1]);
  return new Function(`${src.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };`)();
}
const ds = load('pages/setup/data-source.js');

describe('who is offered the choice (canChooseDataSource)', () => {
  test('an admin', () => {
    expect(ds.canChooseDataSource({ id: 'u1', role: 'admin', demo: false })).toBe(true);
    expect(ds.canChooseDataSource({ id: 'u1', role: 'admin', demo: true })).toBe(true);
  });

  test('nobody else, a demo account included, and nobody before the user is known', () => {
    expect(ds.canChooseDataSource({ id: 'u2', role: 'user' })).toBe(false);
    expect(ds.canChooseDataSource({ id: 'u3', role: 'user', demo: true })).toBe(false);
    expect(ds.canChooseDataSource({ id: 'u4', role: 'Admin' })).toBe(false);
    expect(ds.canChooseDataSource({ id: 'u5' })).toBe(false);
    expect(ds.canChooseDataSource(null)).toBe(false);
    expect(ds.canChooseDataSource(undefined)).toBe(false);
  });
});

describe('which source the account is on (currentSource)', () => {
  test("'demo' for an account showing sample data", () => {
    expect(ds.currentSource({ role: 'admin', demo: true })).toBe('demo');
    expect(ds.currentSource({ role: 'user', demo: true })).toBe('demo');
  });

  test("'xero' otherwise; the flag is read strictly, as connectionView reads it", () => {
    expect(ds.currentSource({ role: 'admin', demo: false })).toBe('xero');
    expect(ds.currentSource({ role: 'admin' })).toBe('xero');
    expect(ds.currentSource({ demo: 'true' })).toBe('xero');
    expect(ds.currentSource({ demo: 1 })).toBe('xero');
    expect(ds.currentSource(null)).toBe('xero');
    expect(ds.currentSource(undefined)).toBe('xero');
  });
});

describe('the two choices (sourceOptions)', () => {
  test('Xero first, then the sample data, keyed as the server names them', () => {
    expect(ds.sourceOptions()).toEqual([
      { key: 'xero', label: 'Xero' },
      { key: 'demo', label: 'Sample data' },
    ]);
  });
});

describe('what is asked before a switch (switchConfirm)', () => {
  test('to the sample data: what the dashboard shows, where posting goes, and that Xero is kept', () => {
    expect(ds.switchConfirm('demo')).toEqual({
      title: 'Use sample data?',
      message: 'The dashboard will show Demo Company Pte Ltd. Anything posted from now on goes to the Demo Company, not Xero. '
             + 'Your Xero connection is kept for when you switch back.',
      confirmLabel: 'Use sample data',
    });
  });

  test('to Xero: what the dashboard shows and where posting goes', () => {
    expect(ds.switchConfirm('xero')).toEqual({
      title: 'Switch to Xero?',
      message: 'The dashboard will show your own Xero data. Anything posted from now on goes to Xero.',
      confirmLabel: 'Switch to Xero',
    });
  });

  test('neither is a danger dialog: switching loses nothing', () => {
    expect(ds.switchConfirm('demo')).not.toHaveProperty('danger');
    expect(ds.switchConfirm('xero')).not.toHaveProperty('danger');
  });
});

describe('the switch (useDataSource)', () => {
  const hook = read('pages/setup/useDataSource.js');

  test('asks first, tells the server, and re-reads the user before it says it worked', () => {
    const body = hook.slice(hook.indexOf('async function switchTo('));
    const order = [
      'if (!(await confirm(switchConfirm(source)))) return false;',
      "await api.put('/setup/data-source', { source });",
      'await refreshUser();',
      'return true;',
    ].map(s => body.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("a refusal is shown as the server words it (the 409 when the watcher is busy), and is not a success", () => {
    expect(hook).toMatch(/catch \(err\) \{\s+toast\.error\(err\.message \|\| 'Could not switch the data source'\);\s+return false;/);
    expect(hook).toContain("window.dispatchEvent(new CustomEvent('xero-connection-changed'));");
  });
});

describe('Setup › Xero Connection is wired to it', () => {
  const page = read('pages/Setup.jsx');
  const card = page.slice(page.indexOf('function XeroConnectionCard('), page.indexOf('function LlmKeysCard('));
  const decision = card.indexOf("if (connectionView(connection, user) === 'demo') {");
  // Up to the card's own return, two spaces in; the demo branch returns at four.
  const demoBranch = card.slice(decision, card.indexOf('\n  return (', decision));

  test('the choice is for admins, and the hook is called with the others, before the card decides', () => {
    expect(page).toContain("import { canChooseDataSource, sourceOptions } from './setup/data-source';");
    expect(page).toContain("import { useDataSource } from './setup/useDataSource';");
    expect(card).toContain('const chooser = canChooseDataSource(user);');
    expect(card.indexOf('useDataSource()')).toBeGreaterThan(-1);
    expect(card.indexOf('useDataSource()')).toBeLessThan(decision);
  });

  test('both states offer it in place of the subtitle; anyone else keeps the subtitle they had', () => {
    expect(demoBranch).toMatch(/\{chooser\s+\? <DataSourceChooser value="demo" onChoose=\{chooseSource\} disabled=\{switching\} \/>\s+: <div className="card-subtitle" style=\{\{ marginBottom: 0 \}\}>\{card\.note\}<\/div>\}/);
    expect(demoBranch).toMatch(/\{chooser && \([\s\S]*?Your Xero connection is kept; switch back any time\./);
    expect(card).toMatch(/\{chooser \? \(\s+<DataSourceChooser value="xero" onChoose=\{chooseSource\} disabled=\{switching\} \/>\s+\) : \(\s+<div className="card-subtitle" style=\{\{ marginBottom: 0 \}\}>\s+Connect via Custom Connection credentials/);
  });

  test('after a switch the card drops the last answers and reads the connection again', () => {
    expect(card).toMatch(/async function chooseSource\(source\) \{\s+if \(!\(await switchTo\(source\)\)\) return;\s+setConnection\(null\);[\s\S]*?setTenants\(null\);[\s\S]*?fetchTenants\(\);\s+\}/);
  });

  test('the control is a pair of pills that never switches to the source already on', () => {
    const chooser = page.slice(page.indexOf('function DataSourceChooser('), page.indexOf('function XeroConnectionCard('));
    expect(chooser).toContain("Show your own Xero data, or the Demo Company’s sample data.");
    expect(chooser).toMatch(/<div role="group" aria-label="Data source"/);
    expect(chooser).toContain('{sourceOptions().map(o => (');
    expect(chooser).toMatch(/type="button" aria-pressed=\{value === o\.key\}/);
    expect(chooser).toContain('onClick={() => { if (o.key !== value) onChoose(o.key); }}');
  });
});

describe('the Dashboard is wired to it', () => {
  const page = read('pages/XeroInsights.jsx');

  test('the page is keyed by the source, so a switch starts it over with no company carried across', () => {
    expect(page).toContain("import { canChooseDataSource, currentSource } from './setup/data-source';");
    expect(page).toMatch(/export default function XeroInsightsPage\(\) \{\s+const \{ user \} = useAuth\(\);\s+return <XeroInsights key=\{currentSource\(user\)\} \/>;\s+\}/);
    expect(page).toMatch(/\nfunction XeroInsights\(\) \{/);
    expect(page).toMatch(/const \[activeTenantId, setActiveTenantId\] = useState\(null\);/);
  });

  test('with no connection, an admin may connect Xero or use the sample data; anyone else sees the card as it was', () => {
    const none = page.slice(page.indexOf('if (!data.connected) {'), page.indexOf('const { organisation, kpis, tenants } = data;'));
    expect(none).toMatch(/\{chooser \? \(/);
    expect(none).toContain('Connect your Xero organisation, or show the Demo Company’s sample data instead.');
    expect(none).toContain("<button className=\"btn btn-primary\" onClick={() => navigate('/setup')}>Connect Xero →</button>");
    expect(none).toContain("<button className=\"btn btn-outline\" disabled={switching} onClick={() => switchTo('demo')}>Use sample data</button>");
    expect(none).toContain("<button className=\"btn btn-primary\" onClick={() => navigate('/setup')}>Go to Setup →</button>");
    expect(none).toContain('This dashboard reads from whatever connection you already set up');
  });

  test('on sample data, an admin has Switch to Xero in the header', () => {
    expect(page).toMatch(/\{chooser && demo && \(\s+<button className="btn btn-outline btn-sm" disabled=\{switching\} onClick=\{\(\) => switchTo\('xero'\)\}>\s+Switch to Xero\s+<\/button>/);
  });
});
