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
