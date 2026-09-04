const { execFileSync } = require('child_process');
const path = require('path');

// Runs ESLint as part of the suite, so it cannot be skipped by forgetting a
// separate command.
//
// This exists because a blank page reached production: useMemo was called in
// Invoices.jsx while the file imported only useState and useEffect. vite bundled
// the free identifier without complaint and the app threw ReferenceError on
// first render. The build was green and all 682 tests passed.
//
// Adding it immediately found a second, older instance the suite had never
// caught: _sum used in ai-insights.js and defined in reports.js, left behind by
// splitting that module — which meant every variance-insights request threw, and
// the UI degrades silently so nothing surfaced it.
//
// Only ERRORS fail this. Warnings (unused vars, exhaustive-deps) are advisory:
// a lint run that fails on style becomes a run people learn to ignore.
describe('lint', () => {
  test('no ESLint errors in main/ or ui/src', () => {
    const root = path.join(__dirname, '../..');
    let output = '';
    try {
      execFileSync('npx', ['eslint', 'main', 'ui/src', '--format', 'json'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      output = '[]';
    } catch (err) {
      // ESLint exits non-zero when it finds errors; the report is still on stdout.
      output = err.stdout || '[]';
    }

    let report;
    try { report = JSON.parse(output); }
    catch { throw new Error('Could not parse the ESLint report:\n' + String(output).slice(0, 500)); }

    const errors = report.flatMap(f =>
      f.messages.filter(m => m.severity === 2).map(m =>
        `${path.relative(root, f.filePath)}:${m.line}  ${m.message}  (${m.ruleId})`));

    expect(errors).toEqual([]);
  }, 120000);
});
