// Runs before every test file (jest "setupFiles").
//
// HTTP keep-alive is switched off for the test process. Node has enabled it on
// the global agent by default since v19, and supertest's model is the opposite
// of what keep-alive assumes: every request(app).get(...) spins up its own
// ephemeral server on a fresh port and tears it down after the response. A
// pooled connection to a server that has since closed produces "socket hang
// up"; a connection reused across servers can desync HTTP framing, which shows
// up as a 400 from Node's parser or a 404 for a route that is certainly
// mounted. The symptom was a different route test failing roughly one run in
// four — never the same one twice, never reproducible by reading the test —
// across every file that drives an Express app through supertest.
//
// Honest scope of this fix: it removed the "socket hang up" and parser-400
// class entirely — neither recurred in ~60 runs afterwards — but a residual,
// rarer flake in the route suites survived it (a router's own 404/401 for state
// written a moment earlier, roughly one full run in three, vanishing under any
// per-request instrumentation). That one is a race between supertest's
// per-request server churn and the setImmediate() background parse that each
// receipt upload leaves behind; the durable fix is one persistent server per
// test (app.listen in beforeEach, close in afterEach) and awaiting that parse
// deterministically instead of settle()'s two ticks. Cross-file leakage,
// process.env replacement in oauth.test.js and module-instance mismatches were
// all investigated and ruled out — don't start there.
const http  = require('http');
const https = require('https');
http.globalAgent  = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
