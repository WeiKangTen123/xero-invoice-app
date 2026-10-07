// A fatal exit under pm2 is one silent restart. Tell Slack why (if a webhook
// is configured) and give the request a moment to leave before exiting;
// ecosystem.config.cjs's backoff keeps a crash loop from becoming a storm.
function fatal(kind, msg) {
  // Set now, not only by the timer: when nothing else holds the event loop
  // open (a refusal at boot, before the server listens) the process ends as
  // soon as the alert has gone, before the timer fires, and it must still end
  // as a failure for pm2 and for anyone reading the exit code.
  process.exitCode = 1;
  console.error(`${kind}:`, msg);
  try { require('./utils/logger').error(kind, { error: msg }); } catch {}
  try { require('./utils/notify').notifyError({ context: `${kind} — process exiting`, error: String(msg).slice(0, 1500) }).catch(() => {}); } catch {}
  setTimeout(() => process.exit(1), 1500).unref();
}
process.on('uncaughtException', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${process.env.PORT || 3000} is already in use — kill the existing process and restart.`);
    process.exit(1);
  }
  // A deliberate refusal (the secrets check below). The message is the whole
  // story; a stack trace would only bury it.
  if (err.code === 'STARTUP_REFUSED') return fatal('STARTUP REFUSED', err.message);
  fatal('FATAL CRASH', `${err.message}\n${err.stack}`);
});
process.on('unhandledRejection', err => {
  fatal('FATAL REJECTION', err?.stack || err?.message || String(err));
});

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

console.log('Starting up...');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);

// ── Secrets ──────────────────────────────────────────────────────────────────
// Xero and IMAP credentials are per-user (set in Setup page per account). The
// server's own two secrets are checked here, before anything else loads and
// before migrations touch the database. Both used to fail open or late: a
// missing JWT_SECRET fell back, outside production, to a value published in
// this repository, so anyone could forge a session; a missing or malformed
// ENCRYPTION_KEY was found only when the first credential was read.
//
// Missing — or, for ENCRYPTION_KEY, unusable by crypto.js under its own rule,
// so nothing encrypted could be read either way — stops the boot. A secret
// that is present but weak is a loud warning and a Slack alert, never a
// refusal: it works, and refusing to start over it would turn a hardening gap
// into an outage. The test suite runs without a .env, so under NODE_ENV=test
// nothing is refused (auth-middleware and crypto.js keep test-only fallbacks).
function checkSecrets(env = process.env) {
  const { jwtSecretProblem } = require('./middleware/auth-middleware');
  const { keyProblem }       = require('./utils/crypto');
  const jwt      = jwtSecretProblem(env.JWT_SECRET);
  const key      = keyProblem(env.ENCRYPTION_KEY);
  const refusals = [jwt.fatal, key].filter(Boolean);
  return { refusals: env.NODE_ENV === 'test' ? [] : refusals, warnings: [jwt.warning].filter(Boolean) };
}
{
  const { refusals, warnings } = checkSecrets();
  for (const w of warnings) {
    console.warn(`WARNING: ${w}`);
    try { require('./utils/logger').warn(w); } catch {}
    try { require('./utils/notify').notifyError({ context: 'Startup security check (server started anyway)', error: w }).catch(() => {}); } catch {}
  }
  if (refusals.length) {
    // Thrown rather than exited: nothing below may run (no migration, no
    // listen), and the crash handler above already gets the reason to the
    // error log and to Slack before the process ends.
    throw Object.assign(new Error(`Refusing to start:\n  - ${refusals.join('\n  - ')}`), { code: 'STARTUP_REFUSED' });
  }
}

const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const { rateLimitKey } = require('./middleware/rate-limit-key');
const morgan      = require('morgan');
const logger      = require('./utils/logger');
const notify      = require('./utils/notify');

require('./db/migrate').run();
const { ensureUserDirectories, getAllUsers, isActive } = require('./utils/users');
const emailWorker               = require('./queue/email-worker');
const claimWorker               = require('./claims/claim-worker');
const { createHandler, submitInvoiceToXero } = require('./utils/invoice-handler');
const { xeroErrMsg }            = require('./xero/xero-utils');
const invoiceStore              = require('./utils/invoice-store');

// Routes
const authRoutes    = require('./routes/auth');
const setupRoutes   = require('./routes/setup');
const processRoutes = require('./routes/process');
const invoiceRoutes = require('./routes/invoices');
const adminRoutes   = require('./routes/admin');
const dashRoutes    = require('./routes/dashboard');
const chatRoutes    = require('./routes/chat');
const xeroOAuthRoutes = require('./routes/xero-oauth');
const xeroReportsRoutes = require('./routes/xero-reports');
const receiptRoutes = require('./routes/receipts');
const claimRoutes = require('./routes/claims');


const app  = express();
const PORT = process.env.PORT || 4000;
const PROD = process.env.NODE_ENV === 'production';

// ── Security & middleware ────────────────────────────────────────────────────
// A Content-Security-Policy written to what this app actually loads, rather
// than switched off. It was off with the note "CSP off for React SPA", but a
// Vite-built SPA needs no concessions here: the page pulls one module script
// and one stylesheet, both same-origin, and there is no CDN anywhere in it.
//
// Directives are listed in full with useDefaults:false so this is the whole
// policy, not a merge with whatever the library ships this version.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // No inline scripts — Vite emits <script type="module" src>. No eval
      // either, so 'unsafe-eval' stays off and string-to-code is blocked.
      scriptSrc:  ["'self'"],
      // 'unsafe-inline' covers exactly one <style> element, the chat markdown
      // rules in ChatAssistant. React's style={{}} props are not inline
      // stylesheets — they are set as DOM properties and CSP never sees them —
      // so this is not the blanket it looks like. Moving that block into
      // globals.css would let it go.
      styleSrc:   ["'self'", "'unsafe-inline'"],
      // blob: for the camera preview on the capture page, data: for inline SVG.
      imgSrc:     ["'self'", 'data:', 'blob:'],
      fontSrc:    ["'self'"],
      connectSrc: ["'self'"],
      // Invoice PDFs are shown in an iframe, served from this origin.
      frameSrc:   ["'self'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
      // Only this app may frame this app — the review page embeds its own PDF
      // route in an iframe, so 'none' broke every preview. Other origins are
      // still refused, which is the clickjacking point.
      frameAncestors: ["'self'"],
    },
  },
}));
app.use(compression());
app.set('trust proxy', 1);
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
// Global rate limit — keyed by authenticated user ID when available, falling
// back to IP. This prevents one shared office IP from exhausting the pool for
// all 10 users at once.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      500,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests — slow down' },
  standardHeaders: true,
  legacyHeaders:   false,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/setup',    setupRoutes);
app.use('/api/process',  processRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/xero',     xeroOAuthRoutes);
app.use('/api/xero-reports', xeroReportsRoutes);
app.use('/api/receipts', receiptRoutes);
app.use('/api/claims', claimRoutes);
// Mounted under /api, not /dashboard — Express matches mounted routers before the
// SPA catch-all below, so owning /dashboard here meant a hard refresh or bookmark
// on the React app's own /dashboard route got this router's JSON (in practice a
// 401, since requireAuth needs an Authorization header a browser navigation never
// sends) instead of index.html.
app.use('/api/dashboard', dashRoutes);
// Legacy alias for the one path that is genuinely a server endpoint rather than a
// SPA route: README, the deployment roadmap, and any external uptime monitor all
// point at /dashboard/health. The org-list root moved to /api/dashboard.
app.get('/dashboard/health', dashRoutes.health);

// ── Serve React UI ───────────────────────────────────────────────────────────
const UI_DIST = path.join(__dirname, '../ui/dist');
if (PROD) {
  // Vite fingerprints everything under /assets, so a given URL's bytes never
  // change — cache it for a year and skip the revalidation round-trip that
  // otherwise costs a mobile connection an RTT per asset per navigation.
  // index.html is the opposite: it is the document that *names* the current
  // fingerprints, so a cached copy is exactly how a browser ends up asking for
  // a bundle that no longer exists. It must never be stored.
  app.use(express.static(UI_DIST, {
    etag: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(path.sep + 'index.html')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
      } else if (filePath.includes(path.sep + 'assets' + path.sep)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  // Clean 404 for missing static assets — prevents browser from receiving index.html
  // for a missing .css or .js file and throwing a strict MIME type error.
  app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Asset not found'));
  // An API path nobody serves is a JSON 404, not the SPA with a 200 — the
  // client turned that HTML into a silent {} and a typo'd route looked fine.
  app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(UI_DIST, 'index.html'));
  });
} else {
  app.all('/api/*', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('/', (_req, res) => res.json({
    app:    'Financial Automation API',
    status: 'running',
    ui:     'Run `npm run dev:ui` in the ui/ folder for the web interface',
    links:  { auth: '/api/auth/status', process: '/api/process/status', health: '/dashboard/health' }
  }));
}

// ── Error handler ────────────────────────────────────────────────────────────
// A body that is not valid JSON is the client's mistake, not ours, and its
// error message must not be logged: JSON.parse quotes the text around the
// fault, so a mistyped sign-in request wrote part of a password into the log,
// which admins read from inside the app (GET /api/admin/logs).
//
// Any other error that says it is the client's fault (a 4xx in err.status or
// err.statusCode, like body-parser's 413 for an oversized upload) is answered
// with that status. Every error used to become a 500, which told a phone
// uploading a large photo that the server had broken, and hid the real 500s
// among them. An error carrying an upstream response (axios, xero-node) is
// not the client's fault even when its status is 4xx: a 400 from Xero is a
// request this server made.
//
// A real 500 is logged with what it takes to find it (stack, method, path,
// user) and alerted to Slack, at most once per distinct message per ten
// minutes, so a route failing on every request is one message, not hundreds.
function clientErrorMessage(err, status) {
  if (status === 413) {
    return err.limit ? `That is too large to send; the limit is ${Math.round(err.limit / 1048576)}MB.` : 'That is too large to send.';
  }
  return (err.expose !== false && err.message) || require('http').STATUS_CODES[status] || 'Request failed';
}
app.use((err, req, res, next) => {
  const where = { method: req.method, path: req.path, userId: req.user?.id };
  if (err.type === 'entity.parse.failed') {
    logger.warn('Malformed request body', where);
    if (res.headersSent) return next(err);
    return res.status(400).json({ error: 'Malformed request body' });
  }
  const status   = Number(err.status || err.statusCode);
  const upstream = err.isAxiosError || err.response !== undefined;
  if (status >= 400 && status < 500 && !upstream) {
    logger.warn('Request rejected', { status, error: err.message, ...where });
    // A response already under way cannot take a status; Express's own
    // handler closes the connection, which is all that is left to do.
    if (res.headersSent) return next(err);
    return res.status(status).json({ error: clientErrorMessage(err, status) });
  }
  // Not every throw is an Error: xero-node throws its response as a string.
  const message = typeof err === 'string' ? err : (err?.message || String(err));
  logger.error('Unhandled error', { error: message, stack: err?.stack, ...where });
  notify.notifyErrorThrottled({
    key:     message,
    context: `${req.method} ${req.path} answered 500${where.userId ? ` (user ${where.userId})` : ''}`,
    error:   message.slice(0, 1500),
  }).catch(() => {});
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Sends cut off by the restart that started this process. Every deploy is a
// restart, so a send in flight at that moment left its row in 'submitting'
// for good: the boot retry below re-submitted it, but claimForSubmit refuses
// 'submitting', and the manual submit refuses it too. The send may well have
// reached Xero, so it is not retried — a person checks Xero first (see
// invoice-store releaseInterrupted). Every account, disabled or not, since
// this only frees rows. Runs synchronously before the server listens and
// before email recovery can start a send of its own, so it never catches a
// send belonging to this process.
const INTERRUPTED_MSG = 'Sending was interrupted by a restart. Check Xero for this document before sending it again.';
function releaseInterruptedSubmissions() {
  try {
    for (const user of getAllUsers()) {
      const userId = String(user.id);
      const moved  = invoiceStore.forUser(userId).releaseInterrupted(INTERRUPTED_MSG);
      if (moved) logger.warn(`${moved} Xero send(s) were interrupted by a restart — held for a person to check`, { userId });
    }
  } catch (err) {
    logger.error('Boot-time release of interrupted Xero sends failed', { error: err.message });
  }
}
releaseInterruptedSubmissions();

// Retry invoices left 'pending' by a previous run. The Xero submission chain
// lives in memory, so any restart orphans the invoices still waiting in it.
// ('submitting' ones were handled above and are not retried.)
// Sequential retry with a 1.5s gap to stay inside Xero's 60 calls/minute limit.
// Firing all at once causes 429 rate-limit errors that then also fail silently.
async function retryStuckSubmissions({ gapMs = 1500 } = {}) {
  try {
    const settingsStore = require('./utils/settings-store');
    for (const user of getAllUsers()) {
      const userId = String(user.id);
      // Nothing is posted for a disabled account. A restart is not the admin
      // changing their mind, and the invoices are still there, pending, if
      // the account is enabled again.
      if (user.disabledAt) {
        logger.info('Boot retry skipped — account is disabled', { userId });
        continue;
      }
      // Respect the same switch the live pipeline does. This retry used to run
      // unconditionally, so a user who had deliberately turned auto-process OFF
      // still had their queued invoices posted to Xero by the next restart —
      // the toggle held right up until the server bounced.
      if (!settingsStore.forUser(userId).get('autoProcess')) {
        logger.info('Boot retry skipped — auto-process is off for this user', { userId });
        continue;
      }
      const store = invoiceStore.forUser(userId);
      const stuck = store.getAll().filter(i => i.status === 'pending');
      if (!stuck.length) continue;
      logger.info(`Retrying ${stuck.length} pending Xero submission(s) on boot`, { userId });
      for (const inv of stuck) {
        // Read again per invoice: the gaps add up, and a disable that lands
        // part-way through must stop the rest.
        if (!isActive(userId)) break;
        // The row may have moved on while this loop waited — sent by the
        // live pipeline, edited, deleted. claimForSubmit would happily take
        // a posted row (that is how a correction is re-sent), so only a row
        // that is still pending goes.
        if (store.getById(inv.id)?.status !== 'pending') continue;
        try {
          await submitInvoiceToXero(userId, inv.id);
        } catch (err) {
          logger.warn('Boot-time Xero retry failed', { id: inv.id, error: xeroErrMsg(err), userId });
        }
        await new Promise(r => setTimeout(r, gapMs));
      }
    }
  } catch (err) {
    logger.error('Boot-time Xero retry scan failed', { error: err.message });
  }
}

// Mailbox watchers that were on before the restart are started again; the
// registry keeps who had one on (user_settings.watcher_enabled). Best effort,
// like the receipt recovery: a registry without the hook, or one that throws
// or rejects, costs the watchers until someone turns them on again, never
// the server. Always resolves.
function resumeMailboxWatchers() {
  return Promise.resolve()
    .then(() => {
      const { resumeWatchers } = require('./email/watcher-registry');
      if (typeof resumeWatchers !== 'function') {
        logger.warn('Mailbox watchers not resumed: the watcher registry has no resumeWatchers()');
        return;
      }
      return resumeWatchers();
    })
    .catch(err => { logger.warn('Mailbox watcher resume failed', { error: err?.message || String(err) }); });
}

// ── Start ────────────────────────────────────────────────────────────────────
// Backstop for abandoned sessions — logout stops a watcher immediately, this
// catches the ones nobody ever came back to. See email/idle-sweeper.js.
require('./email/idle-sweeper').start();

const HOST = process.env.HOST || (PROD ? '127.0.0.1' : '0.0.0.0');
const server = app.listen(PORT, HOST, () => {
  console.log('===========================================');
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log('===========================================');
  logger.info(`Server running on ${HOST}:${PORT} [${process.env.NODE_ENV || 'development'}]`);

  // Ensure every registered user has a data directory and config.json.
  // Safe no-op for users that already have directories.
  ensureUserDirectories();

  // Recover any email parsing jobs that were in-flight when the server last shut down.
  // Jobs are persisted to disk by the IMAP watcher so they survive crashes and nodemon restarts.
  emailWorker.recoverPendingJobs(userId => Promise.resolve(createHandler(userId).onInvoiceEmail));
  logger.info('Email queue recovery check complete');

  // Recover any in-flight claim import jobs persisted to disk.
  claimWorker.recoverPendingJobs();
  logger.info('Claim queue recovery check complete');

  // Receipt reads run in memory, so a restart mid-read left the row unread and
  // the phone saying "Reading…" forever. Re-read what never finished. Best
  // effort: a failure here must not stop the server.
  Promise.resolve()
    .then(() => require('./routes/receipts').resumeUnreadReceipts())
    .catch(err => logger.warn('Unread receipt recovery failed', { error: err.message }));

  // After the queue recoveries above, so mail already on disk is in hand
  // before a watcher can bring in more. Not awaited: nothing here may hold up
  // the server.
  resumeMailboxWatchers();

  // Both recoveries above skip disabled accounts themselves. Email recovery
  // gets a 3s head-start so it can dedup before stuck invoices are resubmitted.
  setTimeout(retryStuckSubmissions, 3000);
});

// ── Shutdown ─────────────────────────────────────────────────────────────────
// Close the server socket explicitly before exiting so the OS releases the port
// immediately. Without this, nodemon can hit EADDRINUSE when restarting because
// the old process exits but the port binding lingers for a moment.
function shutdown(signal) {
  logger.info(`Shutting down (${signal})`);
  // Close IMAP sockets and cancel their reconnect timers. Without this a SIGTERM
  // left them open, and a watcher mid-backoff would try to reconnect during exit.
  try {
    const stopped = require('./email/watcher-registry').stopAll();
    if (stopped) logger.info(`Stopped ${stopped} email watcher(s)`);
  } catch (err) {
    logger.warn('Failed to stop watchers on shutdown', { error: err.message });
  }
  server.close(() => {
    logger.info('Server closed — port released');
    process.exit(0);
  });
  // Safety: force-exit after 5 s if something keeps the server from closing
  setTimeout(() => {
    logger.warn('Forced exit after timeout');
    process.exit(1);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
module.exports.retryStuckSubmissions = retryStuckSubmissions;
module.exports.releaseInterruptedSubmissions = releaseInterruptedSubmissions;
module.exports.resumeMailboxWatchers = resumeMailboxWatchers;
module.exports.checkSecrets = checkSecrets;
