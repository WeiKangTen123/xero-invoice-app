const { spawnSync } = require('child_process');
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
const ROOT   = path.join(__dirname, '../..');
const ESLINT = path.join(ROOT, 'node_modules/eslint/bin/eslint.js');

// ESLint's own entry point, run with the node that is running the suite. It
// used to go through `npx`, which does not exist as an executable on Windows
// (it is npx.cmd), so the spawn failed with ENOENT, the empty stdout was read as
// "no problems", and the gate passed there without linting a single file.
function runEslint(bin = ESLINT, args = ['main', 'ui/src', '--format', 'json']) {
  // The JSON report carries the source of every file with a warning; it is half
  // a megabyte today, and the default 1MB buffer would truncate it into
  // something unparseable as warnings accumulate.
  return spawnSync(process.execPath, [bin, ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// The ESLint errors in one run, or a throw when the run cannot be trusted to
// have checked anything. ESLint exits 0 when clean, 1 when it found errors (the
// report is still on stdout) and 2 when it crashed — a bad config, a plugin
// that failed to load, an option it does not know — with nothing on stdout. An
// empty stdout is therefore never "no problems": the JSON formatter prints at
// least [] for a clean run, so empty means ESLint did not get as far as
// reporting.
function errorsFrom(run) {
  const why = run.error ? `could not be started (${run.error.code || run.error.message})`
    : run.status !== 0 && run.status !== 1 ? `exited ${run.status === null ? `on ${run.signal}` : run.status}`
    : !String(run.stdout || '').trim() ? `exited ${run.status} with nothing on stdout`
    : null;
  if (why) throw new Error(`ESLint ${why}, so nothing was linted:\n${String(run.stderr || '').slice(0, 800)}`);

  let report;
  try { report = JSON.parse(run.stdout); }
  catch { throw new Error('Could not parse the ESLint report:\n' + String(run.stdout).slice(0, 500)); }

  // A config change that ignores a whole tree would also pass with no errors.
  const files = report.map(f => path.relative(ROOT, f.filePath).split(path.sep).join('/'));
  for (const tree of ['main/', 'ui/src/']) {
    if (!files.some(f => f.startsWith(tree))) throw new Error(`ESLint reported no files under ${tree}, so it did not check them`);
  }

  return report.flatMap(f =>
    f.messages.filter(m => m.severity === 2).map(m =>
      `${path.relative(ROOT, f.filePath)}:${m.line}  ${m.message}  (${m.ruleId})`));
}

describe('lint', () => {
  test('no ESLint errors in main/ or ui/src', () => {
    expect(errorsFrom(runEslint())).toEqual([]);
  }, 120000);

  test('errors are reported and warnings are not', () => {
    const report = ['main/a.js', 'ui/src/b.jsx'].map((f, i) => ({
      filePath: path.join(ROOT, f),
      messages: [{ severity: 2 - i, line: 3, message: i ? 'unused' : 'useMemo is not defined', ruleId: i ? 'no-unused-vars' : 'no-undef' }],
    }));
    expect(errorsFrom({ status: 1, stdout: JSON.stringify(report) }))
      .toEqual([`${path.join('main', 'a.js')}:3  useMemo is not defined  (no-undef)`]);
  });

  // The two ways the old gate passed without linting, pinned so the checks
  // above cannot quietly be relaxed back into them.
  describe('a run that did not lint fails rather than passing', () => {
    test('the binary is missing', () => {
      const run = runEslint(path.join(ROOT, 'node_modules/eslint/bin/no-such-eslint.js'));
      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
      expect(() => errorsFrom(run)).toThrow(/nothing on stdout/);
    });

    test('the executable cannot be started at all', () => {
      expect(() => errorsFrom({ error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }), status: null, stdout: '' }))
        .toThrow(/could not be started \(ENOENT\)/);
    });

    test('ESLint crashes', () => {
      // An option ESLint does not know makes the real binary exit 2, the same
      // status a broken config or plugin produces.
      const run = runEslint(ESLINT, ['--no-such-option', 'main']);
      expect(run.status).toBe(2);
      expect(() => errorsFrom(run)).toThrow(/exited 2/);
    });

    test('a crash is not excused by something on stdout', () => {
      expect(() => errorsFrom({ status: 2, stdout: '[]', stderr: 'Oops! Something went wrong!' })).toThrow(/exited 2/);
    });

    test('a report that skips a whole tree', () => {
      const report = [{ filePath: path.join(ROOT, 'main/index.js'), messages: [] }];
      expect(() => errorsFrom({ status: 0, stdout: JSON.stringify(report) })).toThrow(/no files under ui\/src/);
    });
  });
});
