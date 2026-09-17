// Tests must never write into the real data folder or the real logs. Every
// file-writing module resolves its base through utils/paths.js, which reads
// DATA_DIR at load; the logger goes silent under NODE_ENV=test.
{
  const fs = require('fs'), os = require('os'), path = require('path');
  process.env.DATA_DIR  = fs.mkdtempSync(path.join(os.tmpdir(), 'xero-test-'));
  process.env.LOG_LEVEL = 'silent';
}

// Runs before every test file (jest "setupFiles").
//
// HTTP keep-alive is switched off for the test process. Node has enabled it on
// the global agent by default since v19, and supertest's model is the opposite
// of what keep-alive assumes: request(app) starts a server on a fresh port per
// request and tears it down after the response. A pooled connection to a server
// that has since closed is a "socket hang up".
//
// ── If a route test flakes on your machine, read this before investigating ──
//
// The route suites (receipts, claims, auth, invoices, …) showed intermittent
// transport-level failures on a development Mac (Node 24, macOS): a hang, a
// reset, a parser-level 400, a 404 for a route that cannot return one — about
// one full run in three, never the same test twice, vanishing under any
// instrumentation. A long investigation established that it is the
// environment, not the code:
//
//   - the identical committed code on the deployment VM (Node 22, Linux) ran the
//     worst-affected file 32/32 and the full suite 7/7, at one and two workers
//   - cross-file leakage, process.env replacement, module-instance mismatches,
//     id coercion, the background split path and file order were each tested
//     and ruled out
//   - one server per test and an awaitable background read (see receipts) are
//     correct and were kept, but they reduce rather than remove the local rate
//   - running serially (maxWorkers: 1) did not help either — it was tried for
//     a week and only made every run 3.5x slower, so it was removed
//
// So: a red route test on a Mac that is green on Linux and green on re-run is
// this, and the fix is not in the repository.
const http  = require('http');
const https = require('https');
http.globalAgent  = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
