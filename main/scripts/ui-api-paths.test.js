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
