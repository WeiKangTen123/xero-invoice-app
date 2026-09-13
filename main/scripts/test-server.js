// One HTTP server per Express app per test, for supertest.
//
// request(app) makes supertest start a server on a fresh ephemeral port for
// every request and tear it down afterwards. Across a route suite that is
// hundreds of servers per run, and on some machines (see jest.setup.js) that
// churn is where intermittent transport failures came from. request(serverFor
// (app)) hands supertest a server that is already listening, so it reuses it;
// every server opened during a test is closed after that test.
//
// Required once at the top of a test file. The afterEach is registered from
// here so a file cannot adopt the helper and forget the teardown.
const _servers = new Map(); // app -> http.Server

function serverFor(app) {
  let s = _servers.get(app);
  if (!s || !s.listening) {
    s = app.listen(0);
    _servers.set(app, s);
  }
  return s;
}

function closeTestServers() {
  const open = [..._servers.values()];
  _servers.clear();
  return Promise.all(open.map(s => new Promise(resolve => (s.listening ? s.close(() => resolve()) : resolve()))));
}

if (typeof afterEach === 'function') afterEach(closeTestServers);

module.exports = { serverFor, closeTestServers };
