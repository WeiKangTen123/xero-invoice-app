const fs   = require('fs');
const path = require('path');

// api/client.js prepends BASE = '/api' to every path. Passing '/api/receipts'
// therefore requests '/api/api/receipts', which 404s — and because a 404 is not
// a 401, it surfaces as a generic "HTTP 404" rather than anything that points at
// the cause. That shipped once and broke both the phone pairing and the upload
// button, so it is pinned here rather than left to review.
const UI_SRC = path.join(__dirname, '../../ui/src');

function jsxFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsxFiles(full, out);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('UI API paths', () => {
  const files = jsxFiles(UI_SRC);

  test('the UI source tree is actually being scanned', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test('BASE is still /api, which is what makes the rule below necessary', () => {
    const client = fs.readFileSync(path.join(UI_SRC, 'api/client.js'), 'utf8');
    expect(client).toMatch(/const BASE\s*=\s*'\/api'/);
  });

  test('no api.* call passes a path that repeats the /api prefix', () => {
    // Matches api.get('/api/...'), api.post(`/api/...`), etc.
    const offender = /\bapi\.(get|post|patch|delete|put)\(\s*['"`]\/api\//;
    const bad = [];

    for (const file of files) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (offender.test(line)) bad.push(`${path.relative(UI_SRC, file)}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(bad).toEqual([]);
  });

  test('raw fetch() calls DO need the full path, and keep it', () => {
    // Capture.jsx deliberately bypasses the client — it has no token to send —
    // so its paths must include /api. The two rules are opposites and it is easy
    // to "fix" one into breaking the other.
    const capture = fs.readFileSync(path.join(UI_SRC, 'pages/Capture.jsx'), 'utf8');
    const fetches = capture.match(/fetch\(\s*[`'"][^`'"]+/g) || [];
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) expect(f).toMatch(/\/api\//);
  });
});

// ── Free identifiers ────────────────────────────────────────────────────────
// vite bundles free identifiers without complaint — they only explode at
// runtime. useMemo was used in Invoices.jsx while the file imported only
// useState and useEffect: the build passed, the suite passed, and the page went
// black on first render. A build succeeding is not evidence the page renders.
const REACT_HOOKS = [
  'useState', 'useEffect', 'useMemo', 'useRef', 'useCallback',
  'useContext', 'useReducer', 'useLayoutEffect', 'useId',
];

describe('UI React hooks are imported where they are used', () => {
  const files = jsxFiles(UI_SRC);

  test('every hook a file calls is in its react import', () => {
    const missing = [];

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]react['"]/);
      const imported = new Set((importMatch ? importMatch[1] : '').split(',').map(s => s.trim()));

      for (const hook of REACT_HOOKS) {
        // A call, not a mention in a comment or a string.
        if (!new RegExp(`\\b${hook}\\s*\\(`).test(src)) continue;
        if (imported.has(hook)) continue;
        // React.useMemo(...) is legitimate without a named import.
        if (new RegExp(`React\\.${hook}\\s*\\(`).test(src)) continue;
        missing.push(`${path.relative(UI_SRC, file)} calls ${hook} without importing it`);
      }
    }

    expect(missing).toEqual([]);
  });

  test('the scan reaches the files that actually use hooks', () => {
    const withHooks = files.filter(f => /\buseState\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(withHooks.length).toBeGreaterThan(3);
  });
});

// ── Every call goes somewhere ───────────────────────────────────────────────
// The rules above catch a repeated prefix. They do not catch a path that is
// simply wrong: `/admin/users/resolve` when the server only has
// `/admin/reports/:id/resolve`. That shipped too, and every click on the
// button was a 404 nobody saw. So: read the server's routes and check that
// each literal path the UI calls is one of them, verb included.
const MAIN = path.join(__dirname, '..');

function serverRoutes() {
  const index  = fs.readFileSync(path.join(MAIN, 'index.js'), 'utf8');
  const files  = {};
  for (const m of index.matchAll(/const\s+(\w+)\s*=\s*require\('\.\/routes\/([\w-]+)'\)/g)) files[m[1]] = m[2];
  const routes = [];
  for (const m of index.matchAll(/app\.use\('(\/api\/[\w-]+)',\s*(\w+)\)/g)) {
    const [, mount, variable] = m;
    const file = files[variable];
    if (!file) continue;
    const src = fs.readFileSync(path.join(MAIN, 'routes', `${file}.js`), 'utf8');
    for (const r of src.matchAll(/router\.(get|post|patch|put|delete|all)\(\s*'([^']*)'/g)) {
      routes.push({ verb: r[1], path: (mount + (r[2] === '/' ? '' : r[2])).replace(/^\/api/, '') });
    }
  }
  return routes;
}

// The first argument of api.<verb>(, read as source text: a quoted string, or
// a template literal whose ${…} parts (which may themselves contain quotes)
// are skipped over rather than cutting the literal short.
function literalAt(src, from) {
  const quote = src[from];
  let depth = 0, out = '';
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (depth > 0) {
      // Inside ${…}: only the braces matter, and a nested template's own ${
      // is just another brace to balance.
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) out += '${}';
      continue;
    }
    if (c === quote) return out;
    if (quote === '`' && c === '$' && src[i + 1] === '{') { depth = 1; i++; continue; }
    out += c;
  }
  return null;
}

// '/invoices/${id}/report' → ['invoices', '*', 'report']; a query is dropped;
// '/accounts${qs}' → ['accounts*'] (a segment that starts with "accounts").
function uiSegments(literal) {
  return literal.replace(/\$\{\}/g, '*').split('?')[0].split('/').filter(Boolean);
}

function segMatches(ui, route) {
  if (route.startsWith(':') || route === '*' || ui === '*') return true;
  if (ui.endsWith('*')) return route.startsWith(ui.slice(0, -1));
  return ui === route;
}

function matches(uiSegs, routePath) {
  const rs = routePath.split('/').filter(Boolean);
  if (rs.length !== uiSegs.length) return false;
  return rs.every((seg, i) => segMatches(uiSegs[i], seg));
}

describe('every literal API path the UI calls exists on the server', () => {
  const routes = serverRoutes();
  const files  = jsxFiles(UI_SRC);

  test('the server routes were actually read', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(routes).toContainEqual({ verb: 'get', path: '/invoices/:id' });
  });

  test('each call resolves to a route with the same verb', () => {
    const bad = [];
    let checked = 0;
    const call = /\bapi\.(get|post|patch|delete|put)\(\s*(?=['"`])/g;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(call)) {
        const verb    = m[1];
        const literal = literalAt(src, m.index + m[0].length);
        if (literal === null) { bad.push(`${path.relative(UI_SRC, file)}: unreadable literal after api.${verb}(`); continue; }
        checked++;
        const segs = uiSegments(literal);
        const ok = routes.some(r => (r.verb === verb || r.verb === 'all') && matches(segs, r.path));
        if (!ok) bad.push(`${path.relative(UI_SRC, file)}: api.${verb}('${literal}')`);
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(bad).toEqual([]);
  });
});
