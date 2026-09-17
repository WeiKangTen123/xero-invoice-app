// Express 4 does not catch a rejected async handler, and index.js turns every
// unhandled rejection into process.exit(1) — so one bad request in an
// un-wrapped async route restarted the server for everyone. Wrapping the
// route hands a throw to the error handler like any synchronous failure.
module.exports = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
