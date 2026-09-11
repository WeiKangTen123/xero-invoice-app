process.on('uncaughtException', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${process.env.PORT || 3000} is already in use — kill the existing process and restart.`);
  } else {
    console.error('FATAL CRASH:', err.message, err.stack);
  }
  process.exit(1);
});
process.on('unhandledRejection', err => {
  const msg = err?.stack || err?.message || String(err);
  console.error('FATAL REJECTION:', msg);
  try { require('./utils/logger').error('FATAL REJECTION', { error: msg }); } catch {}
  process.exit(1);
});

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

console.log('Starting up...');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('XERO_CLIENT_ID set:', !!process.env.XERO_CLIENT_ID);

// Xero and IMAP credentials are now per-user (set in Setup page per account).
// Only JWT_SECRET is strictly required at boot.

const express     = require('express');
const path        = require('path');
const helmet      = require('helmet');
const compression = require('compression');
const rateLimit   = require('express-rate-limit');
const morgan      = require('morgan');
const logger      = require('./utils/logger');

const { jwtSecret }             = require('./middleware/auth-middleware');
require('./db/migrate').run();
const { ensureUserDirectories, getAllUsers } = require('./utils/users');
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
      // Nothing should ever frame this app — the clickjacking counterpart to
      // the X-Frame-Options header helmet also sets.
      frameAncestors: ["'none'"],
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
  keyGenerator: (req) => {
    // Prefer JWT user ID so each user has their own bucket
    try {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const jwt     = require('jsonwebtoken');
        const payload = jwt.verify(auth.slice(7), jwtSecret());
        return `user:${payload.id}`;
      }
    } catch (_) {}
    return req.ip;
  },
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
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(UI_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.json({
    app:    'Xero Invoice Automation API',
    status: 'running',
    ui:     'Run `npm run dev:ui` in the ui/ folder for the web interface',
    links:  { auth: '/api/auth/status', process: '/api/process/status', health: '/dashboard/health' }
  }));
}

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

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

  // Retry any invoices stuck in 'pending' or 'submitting' from a previous run.
  // The Xero submission chain lives in-memory, so any restart orphans pending invoices.
  // We give email recovery a 3s head-start so it can dedup before we submit.
  // Sequential retry with 1.5s gap to stay inside Xero's 60 calls/minute limit.
  // Firing all at once causes 429 rate-limit errors that then also fail silently.
  setTimeout(async () => {
    try {
      const settingsStore = require('./utils/settings-store');
      const userIds = getAllUsers().map(u => String(u.id));
      for (const userId of userIds) {
        // Respect the same switch the live pipeline does. This retry used to run
        // unconditionally, so a user who had deliberately turned auto-process OFF
        // still had their queued invoices posted to Xero by the next restart —
        // the toggle held right up until the server bounced.
        if (!settingsStore.forUser(userId).get('autoProcess')) {
          logger.info('Boot retry skipped — auto-process is off for this user', { userId });
          continue;
        }
        const stuck = invoiceStore.forUser(userId).getAll()
          .filter(i => i.status === 'pending' || i.status === 'submitting');
        if (!stuck.length) continue;
        logger.info(`Retrying ${stuck.length} pending Xero submission(s) on boot`, { userId });
        for (const inv of stuck) {
          try {
            await submitInvoiceToXero(userId, inv.id);
          } catch (err) {
            logger.warn('Boot-time Xero retry failed', { id: inv.id, error: xeroErrMsg(err), userId });
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch (err) {
      logger.error('Boot-time Xero retry scan failed', { error: err.message });
    }
  }, 3000);
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
